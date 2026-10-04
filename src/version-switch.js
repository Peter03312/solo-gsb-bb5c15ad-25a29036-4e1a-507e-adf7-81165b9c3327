const crypto = require('crypto');
const { db, transaction, roleSceneHash } = require('./db');
const { badRequest, conflict } = require('./errors');
const { getVersionOfPlayOrThrow } = require('./plays');
const {
  participantDetails,
  buildCandidate,
  findScheduleConflicts,
  findUnavailabilityConflicts,
  notificationFingerprint,
} = require('./schedules');

/**
 * 换版预演与凭预演提交。
 *
 * 预演（buildSwitchPlan / createSwitchPreview）完全只读：
 *   不改写版本、确认、日程、签到快照或通知，只在 version_switch_previews 留下一条凭证。
 * 预演列出：
 *   - 各角色 × 场次的确认将“保留 / 重做 / 作废”；
 *   - 各有效日程将“继续有效（参与者可能变化）/ 转为待调整”（已取消日程不参与）；
 *   - 参与演员与各时段通知接收人的变化（加入/退出/角色变化、新批次/批次失效/不变）；
 *   - 与其他有效日程（端点相接不算）或演员不可用时段的冲突（待调整/已取消不参与）。
 *
 * 提交（commitSwitchPreview）凭预演 token：
 *   - 重算 state_hash：排练版本、派角、相关日程、参与演员不可用记录变化 => 409 PREVIEW_STALE；
 *   - 预演存在冲突 => 整次换版不生效，返回与预演一致的冲突详情；
 *   - 成功提交与预演结果一致，沿用现有换版的确认/日程/通知语义；签到快照保持不变。
 *
 * 依赖方向：rehearsals.js（路由）→ 本模块 → schedules.js / plays.js / db；
 * 本模块需要 rehearsals.js 的执行结果序列化器，通过惰性 require 避免循环依赖。
 */

const PREVIEW_TTL_MS = 30 * 60 * 1000;

// ---- 通用小工具 ----
function roleBrief(roleId) {
  const role = db.prepare('SELECT id, code, name FROM roles WHERE id = ?').get(roleId);
  return { roleId, roleCode: role?.code ?? null, roleName: role?.name ?? null };
}

function actorBrief(actorId) {
  const a = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(actorId);
  return { actorId, actorUsername: a?.username ?? null, actorName: a?.display_name ?? `#${actorId}` };
}

function sceneTitleOf(sceneId) {
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(sceneId);
  return scene ? `${scene.code} ${scene.title}` : `#${sceneId}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** 规范化 JSON（键排序、数组按给定键稳定），用于指纹 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function roleIdsOf(participant) {
  return participant.roles.map((r) => r.roleId).sort((a, b) => a - b);
}

/** 两个参与者集合的差异：加入 / 退出 / 角色变化（按演员） */
function participantDiff(before, after) {
  const beforeMap = new Map(before.map((p) => [p.actorId, p]));
  const afterMap = new Map(after.map((p) => [p.actorId, p]));
  const added = [];
  const removed = [];
  const rolesChanged = [];
  for (const p of after) {
    if (!beforeMap.has(p.actorId)) added.push({ ...actorBrief(p.actorId), roles: p.roles });
  }
  for (const p of before) {
    if (!afterMap.has(p.actorId)) removed.push({ ...actorBrief(p.actorId), roles: p.roles });
  }
  for (const p of after) {
    const old = beforeMap.get(p.actorId);
    if (!old) continue;
    const oldIds = roleIdsOf(old);
    const newIds = roleIdsOf(p);
    if (stableStringify(oldIds) !== stableStringify(newIds)) {
      rolesChanged.push({
        ...actorBrief(p.actorId),
        beforeRoles: old.roles,
        afterRoles: p.roles,
      });
    }
  }
  return { added, removed, rolesChanged };
}

// ---- 确认投影：各角色 × 场次保留 / 重做 / 作废 ----
function planConfirmations(rehearsal, cast, targetVersionId) {
  const oldVersionId = rehearsal.version_id;
  const entries = [];
  const stats = { keep: 0, redo: 0, discard: 0, discardedConfirmationRows: 0 };

  for (const c of cast) {
    const newScenes = new Set(
      db
        .prepare('SELECT DISTINCT scene_id FROM version_lines WHERE version_id = ? AND role_id = ?')
        .all(targetVersionId, c.role_id)
        .map((x) => x.scene_id)
    );
    const oldScenes = new Set(
      db
        .prepare('SELECT DISTINCT scene_id FROM version_lines WHERE version_id = ? AND role_id = ?')
        .all(oldVersionId, c.role_id)
        .map((x) => x.scene_id)
    );
    const allConfirmations = db
      .prepare('SELECT * FROM confirmations WHERE rehearsal_id = ? AND role_id = ?')
      .all(rehearsal.id, c.role_id);

    // 1) 新版本仍有台词的场次：当前派角演员的确认保留/重做
    const redoByScene = new Map();
    for (const sceneId of newScenes) {
      const oldHash = oldScenes.has(sceneId) ? roleSceneHash(oldVersionId, c.role_id, sceneId) : null;
      const newHash = roleSceneHash(targetVersionId, c.role_id, sceneId);
      const mine = allConfirmations.find((conf) => conf.actor_id === c.actor_id && conf.scene_id === sceneId);
      // 与执行器逐字一致：仅当本人确认存在、内容与旧版一致、且新旧内容未变时才保留
      const willKeep = !!mine && mine.content_hash === oldHash && oldHash === newHash;
      if (willKeep) {
        stats.keep++;
        continue;
      }
      const othersCount = allConfirmations.filter(
        (conf) => conf.scene_id === sceneId && conf.actor_id !== c.actor_id
      ).length;
      let reason;
      if (mine) reason = '换版后台词文本已变化，需重新确认';
      else if (othersCount > 0) reason = '角色已改派，原演员确认不计入';
      else reason = '尚未确认';
      const entry = {
        action: 'redo',
        ...roleBrief(c.role_id),
        ...actorBrief(c.actor_id),
        sceneId,
        sceneTitle: sceneTitleOf(sceneId),
        reason,
        discardedConfirmations: [],
      };
      redoByScene.set(sceneId, entry);
      entries.push(entry);
      stats.redo++;
    }

    // 2) 逐行核对该角色的全部确认（含改派前演员的历史确认）哪些会被删除：
    //    - 新版本该角色在此场次无台词 => 作废；
    //    - 仍有台词但内容陈旧（非“旧版原文且新旧一致”）=> 随重做作废。
    const discardsByScene = new Map();
    for (const conf of allConfirmations) {
      const oldHash = roleSceneHash(oldVersionId, c.role_id, conf.scene_id);
      const newHash = newScenes.has(conf.scene_id)
        ? roleSceneHash(targetVersionId, c.role_id, conf.scene_id)
        : null;
      const willKeep = newScenes.has(conf.scene_id) && conf.content_hash === oldHash && oldHash === newHash;
      if (willKeep) continue;
      const item = {
        confirmationId: conf.id,
        ...actorBrief(conf.actor_id),
        sceneId: conf.scene_id,
        sceneTitle: sceneTitleOf(conf.scene_id),
        reason:
          conf.actor_id === c.actor_id
            ? newScenes.has(conf.scene_id)
              ? '当前确认对应旧版台词，换版后将作废重确'
              : '新版本中该角色在此场次已无台词，确认作废'
            : newScenes.has(conf.scene_id)
              ? '改派前演员的历史确认随文本变化作废'
              : '新版本中该角色在此场次已无台词，历史确认作废',
      };
      if (!newScenes.has(conf.scene_id)) {
        if (!discardsByScene.has(conf.scene_id)) discardsByScene.set(conf.scene_id, []);
        discardsByScene.get(conf.scene_id).push(item);
      } else {
        redoByScene.get(conf.scene_id)?.discardedConfirmations.push(item);
      }
      stats.discardedConfirmationRows++;
    }
    for (const [sceneId, items] of discardsByScene) {
      stats.discard++;
      entries.push({
        action: 'discard',
        ...roleBrief(c.role_id),
        ...actorBrief(c.actor_id),
        sceneId,
        sceneTitle: sceneTitleOf(sceneId),
        reason: '新版本中该角色在此场次已无台词，既有确认作废',
        discardedConfirmations: items,
      });
    }
  }

  entries.sort((a, b) => {
    const ra = a.roleId - b.roleId;
    if (ra) return ra;
    return (a.sceneId ?? 0) - (b.sceneId ?? 0);
  });
  return { entries, stats };
}

// ---- 日程投影：继续有效 / 转为待调整 + 参与者与通知接收人变化 ----
function planSchedules(rehearsal, targetVersionId) {
  const rows = db
    .prepare('SELECT * FROM rehearsal_schedules WHERE rehearsal_id = ? ORDER BY start_at, id')
    .all(rehearsal.id);
  const nonCancelled = rows.filter((s) => s.status !== 'cancelled');
  const candidates = [];
  const schedules = [];

  const participantChanges = [];
  let newBatches = 0;
  let inactiveBatches = 0;
  let unchangedBatches = 0;
  let stayActive = 0;
  let becomeNeedsAdjustment = 0;
  let alreadyNeedsAdjustment = 0;
  const needsAdjustmentSchedules = [];

  for (const s of nonCancelled) {
    const hasLines = db
      .prepare('SELECT 1 FROM version_lines WHERE version_id = ? AND scene_id = ? LIMIT 1')
      .get(targetVersionId, s.scene_id);

    const current = db
      .prepare("SELECT * FROM schedule_notifications WHERE schedule_id = ? AND status = 'current'")
      .get(s.id);

    const base = {
      scheduleId: s.id,
      sceneId: s.scene_id,
      sceneTitle: sceneTitleOf(s.scene_id),
      startAt: s.start_at,
      endAt: s.end_at,
      statusBefore: s.status,
      currentNotification: current
        ? { id: current.id, seq: current.seq, status: current.status }
        : null,
    };

    // 已经是待调整的安排：换版不触碰（沿用现有 applySchedulesAfterVersionSwitch 语义）
    if (s.status === 'needs_adjustment') {
      alreadyNeedsAdjustment++;
      unchangedBatches++;
      schedules.push({
        ...base,
        outcome: 'already_needs_adjustment',
        scheduleStatusAfter: 'needs_adjustment',
        participantsBefore: [],
        participantsAfter: [],
        participantChange: { added: [], removed: [], rolesChanged: [] },
        notification: {
          action: 'unchanged',
          reason: '该时段已处于待调整，换版不改变其状态',
          newSeq: current ? current.seq : null,
        },
      });
      continue;
    }

    // 当前（旧版本）参与者
    const before = participantDetails(rehearsal.id, rehearsal.version_id, s.scene_id).participants;

    if (!hasLines) {
      // 新版本该场次已无台词 => 转为待调整：不参与冲突检测；当前批次将失效
      becomeNeedsAdjustment++;
      needsAdjustmentSchedules.push(s.id);
      inactiveBatches++;
      const change = participantDiff(before, []);
      participantChanges.push({ scheduleId: s.id, scheduleTitle: base.sceneTitle, ...change });
      schedules.push({
        ...base,
        outcome: 'become_needs_adjustment',
        scheduleStatusAfter: 'needs_adjustment',
        participantsBefore: before,
        participantsAfter: [],
        participantChange: change,
        notification: {
          action: current ? 'inactive' : 'unchanged',
          reason: '时段转为待调整，当前通知批次不再待确认',
          newSeq: null,
        },
      });
      continue;
    }

    // 继续有效：按新版本重算参与者，并纳入冲突候选
    stayActive++;
    const after = participantDetails(rehearsal.id, targetVersionId, s.scene_id).participants;
    candidates.push(
      buildCandidate({
        scheduleId: s.id,
        rehearsal,
        sceneId: s.scene_id,
        startAt: s.start_at,
        endAt: s.end_at,
        versionId: targetVersionId,
      })
    );
    const change = participantDiff(before, after);
    if (change.added.length || change.removed.length || change.rolesChanged.length) {
      participantChanges.push({ scheduleId: s.id, scheduleTitle: base.sceneTitle, ...change });
    }

    // 通知：仍有效时段按最终结果比对当前批次指纹（与 syncScheduleNotifications 完全一致）
    const fp = notificationFingerprint({
      sceneId: s.scene_id,
      versionId: targetVersionId,
      startAt: s.start_at,
      endAt: s.end_at,
      participants: after,
    });
    let notificationAction;
    let notificationReason;
    let newSeq = null;
    if (!current || current.fingerprint !== fp) {
      notificationAction = 'new_batch';
      notificationReason = current
        ? '固定版本或参与演员发生变化，将生成新通知批次，旧批次转为已取代'
        : '该时段当前无通知批次，将生成新批次';
      const nextSeq = db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM schedule_notifications WHERE schedule_id = ?')
        .get(s.id).n;
      newSeq = nextSeq;
      newBatches++;
    } else {
      notificationAction = 'unchanged';
      notificationReason = '时段、场次、固定版本与参与演员均无实质变化，不重复生成批次';
      newSeq = current.seq;
      unchangedBatches++;
    }

    schedules.push({
      ...base,
      outcome: 'stay_active',
      scheduleStatusAfter: 'active',
      participantsBefore: before,
      participantsAfter: after,
      participantChange: change,
      notification: { action: notificationAction, reason: notificationReason, newSeq },
    });
  }

  // 全局参与演员变化汇总（仅按演员去重，便于页面快速提示）
  const aggregate = new Map();
  const ensure = (actorId) => {
    if (!aggregate.has(actorId)) {
      aggregate.set(actorId, { ...actorBrief(actorId), addedTo: [], removedFrom: [], rolesChangedOn: [] });
    }
    return aggregate.get(actorId);
  };
  for (const ch of participantChanges) {
    for (const a of ch.added) {
      ensure(a.actorId).addedTo.push({ scheduleId: ch.scheduleId, sceneTitle: ch.scheduleTitle, roles: a.roles });
    }
    for (const a of ch.removed) {
      ensure(a.actorId).removedFrom.push({ scheduleId: ch.scheduleId, sceneTitle: ch.scheduleTitle, roles: a.roles });
    }
    for (const a of ch.rolesChanged) {
      ensure(a.actorId).rolesChangedOn.push({
        scheduleId: ch.scheduleId,
        sceneTitle: ch.scheduleTitle,
        beforeRoles: a.beforeRoles,
        afterRoles: a.afterRoles,
      });
    }
  }

  return {
    schedules,
    candidates,
    needsAdjustmentSchedules,
    counts: {
      total: rows.length,
      cancelled: rows.length - nonCancelled.length,
      stayActive,
      becomeNeedsAdjustment,
      alreadyNeedsAdjustment,
    },
    notifications: { newBatches, inactiveBatches, unchangedBatches },
    participantChanges,
    participantChangesAggregated: [...aggregate.values()].sort((a, b) => a.actorId - b.actorId),
  };
}

/**
 * 预演总规划（纯只读，不触碰任何业务表）。
 * 返回确认、日程、参与者/通知变化与冲突详情。
 */
function buildSwitchPlan(rehearsal, targetVersionId) {
  const target = getVersionOfPlayOrThrow(targetVersionId, rehearsal.play_id);
  const cast = db
    .prepare(
      `SELECT c.*, ro.name AS role_name, ro.code AS role_code
         FROM rehearsal_cast c
         JOIN roles ro ON ro.id = c.role_id
        WHERE c.rehearsal_id = ? ORDER BY ro.id`
    )
    .all(rehearsal.id);

  const confirmations = planConfirmations(rehearsal, cast, targetVersionId);
  const schedulesPlan = planSchedules(rehearsal, targetVersionId);

  // 冲突：候选之间（同排练换版后的多段时段）+ 与其他排练有效时段；
  // 本排练现有 active 时段整体排除（它们均以候选身份出现，待调整的不参与）。
  const scheduleConflicts = findScheduleConflicts(schedulesPlan.candidates, {
    excludeRehearsalId: rehearsal.id,
  });
  const unavailabilityConflicts = findUnavailabilityConflicts(schedulesPlan.candidates);
  const conflicts = [
    ...scheduleConflicts.map((c) => ({ type: 'schedule', ...c })),
    ...unavailabilityConflicts.map((c) => ({ type: 'unavailability', ...c })),
  ];

  return {
    fromVersionId: rehearsal.version_id,
    targetVersionId,
    targetVersionNo: target.version_no,
    confirmations: confirmations.entries,
    confirmationStats: confirmations.stats,
    schedules: schedulesPlan.schedules,
    scheduleCounts: schedulesPlan.counts,
    needsAdjustmentSchedules: schedulesPlan.needsAdjustmentSchedules,
    participantChanges: schedulesPlan.participantChanges,
    participantChangesAggregated: schedulesPlan.participantChangesAggregated,
    notificationSummary: schedulesPlan.notifications,
    conflicts,
    hasConflicts: conflicts.length > 0,
  };
}

/** 预演结果指纹：提交成功必须与预演时一致（state_hash 已保证输入未变，此值供复核/比对） */
function planResultHash(plan) {
  const { hasConflicts } = plan;
  const projection = {
    fromVersionId: plan.fromVersionId,
    targetVersionId: plan.targetVersionId,
    confirmationStats: plan.confirmationStats,
    confirmations: plan.confirmations.map((e) => ({
      action: e.action,
      roleId: e.roleId,
      actorId: e.actorId,
      sceneId: e.sceneId,
      discarded: e.discardedConfirmations.map((d) => d.confirmationId).sort((a, b) => a - b),
    })),
    schedules: plan.schedules.map((s) => ({
      scheduleId: s.scheduleId,
      outcome: s.outcome,
      after: s.participantsAfter.map((p) => ({
        actorId: p.actorId,
        roleIds: roleIdsOf(p),
      })),
      notification: s.notification.action,
    })),
    conflictCount: plan.conflicts.length,
    conflicts: plan.conflicts.map((c) =>
      c.type === 'schedule'
        ? {
            type: 'schedule',
            actorId: c.actorId,
            schedule: { id: c.schedule.id, startAt: c.schedule.startAt, endAt: c.schedule.endAt },
            overlapsWith: {
              id: c.overlapsWith.id,
              rehearsalId: c.overlapsWith.rehearsalId,
              startAt: c.overlapsWith.startAt,
              endAt: c.overlapsWith.endAt,
            },
          }
        : {
            type: 'unavailability',
            actorId: c.actorId,
            schedule: { id: c.schedule.id, startAt: c.schedule.startAt, endAt: c.schedule.endAt },
            unavailability: { id: c.unavailability.id, startAt: c.unavailability.startAt, endAt: c.unavailability.endAt },
          }
    ),
  };
  return sha256(stableStringify({ hasConflicts, projection }));
}

/**
 * 换版输入状态指纹：决定“预演结果”是否仍然成立。
 *
 * 以单调变化序号（state_sequences，由表触发器在每次相关写操作时 bump）为准：
 *   - 本排练的版本/派角/确认/日程，以及受影响演员参与的其他排练的派角/日程；
 *   - 参与演员不可用记录的登记/修改/撤销。
 * 其他排练的“台词确认”与本换版结论无关，不计入。
 * 序号单调递增，因此即使预演后“增改后又改回原样”（内容快照无法察觉）也会被识别为过期。
 * 另保留一份内容快照做兜底（如数据被绕过触发器直接改动）。
 */
function switchStateHash(rehearsal) {
  const actorIds = db
    .prepare('SELECT DISTINCT actor_id FROM rehearsal_cast WHERE rehearsal_id = ? ORDER BY actor_id')
    .all(rehearsal.id)
    .map((x) => x.actor_id);

  // 受影响演员参与的全部排练（含本排练）：这些排练的日程/派角变化都会影响冲突面
  let rehearsalIds = [rehearsal.id];
  if (actorIds.length) {
    const ph = actorIds.map(() => '?').join(',');
    rehearsalIds = db
      .prepare(`SELECT DISTINCT rehearsal_id FROM rehearsal_cast WHERE actor_id IN (${ph})`)
      .all(...actorIds)
      .map((x) => x.rehearsal_id)
      .sort((a, b) => a - b);
  }

  const seqOf = (scope) =>
    db.prepare('SELECT seq FROM state_sequences WHERE scope = ?').get(scope)?.seq ?? 0;
  const sequences = { ver: {}, cast: {}, conf: {}, sched: {}, unavail: {} };
  for (const id of rehearsalIds) {
    sequences.ver[`r${id}`] = seqOf(`seq:ver:${id}`);
    sequences.cast[`r${id}`] = seqOf(`seq:cast:${id}`);
    sequences.sched[`r${id}`] = seqOf(`seq:sched:${id}`);
  }
  // 其他排练的台词确认与本换版无关，仅快照本排练的确认序号
  sequences.conf[`r${rehearsal.id}`] = seqOf(`seq:conf:${rehearsal.id}`);
  for (const id of actorIds) {
    sequences.unavail[`a${id}`] = seqOf(`seq:unavail:${id}`);
  }

  // 内容快照兜底
  const self = {
    rehearsal: { id: rehearsal.id, versionId: rehearsal.version_id },
    cast: db
      .prepare('SELECT role_id, actor_id, assigned_at FROM rehearsal_cast WHERE rehearsal_id = ? ORDER BY role_id')
      .all(rehearsal.id),
    confirmations: db
      .prepare(
        'SELECT id, role_id, actor_id, scene_id, content_hash, confirmed_at FROM confirmations WHERE rehearsal_id = ? ORDER BY id'
      )
      .all(rehearsal.id),
    schedules: db
      .prepare(
        'SELECT id, scene_id, start_at, end_at, status, cancelled_at FROM rehearsal_schedules WHERE rehearsal_id = ? ORDER BY id'
      )
      .all(rehearsal.id),
  };

  let otherSchedules = [];
  if (actorIds.length) {
    const ph = actorIds.map(() => '?').join(',');
    otherSchedules = db
      .prepare(
        `SELECT s.id, s.rehearsal_id, s.scene_id, s.start_at, s.end_at, r.version_id
           FROM rehearsal_schedules s
           JOIN rehearsals r ON r.id = s.rehearsal_id
          WHERE s.status = 'active'
            AND s.rehearsal_id <> ?
            AND EXISTS (
              SELECT 1 FROM rehearsal_cast c
               WHERE c.rehearsal_id = s.rehearsal_id AND c.actor_id IN (${ph})
            )
          ORDER BY s.id`
      )
      .all(rehearsal.id, ...actorIds);
  }

  let unavailability = [];
  if (actorIds.length) {
    const ph = actorIds.map(() => '?').join(',');
    unavailability = db
      .prepare(
        `SELECT id, actor_id, start_at, end_at, reason, updated_at
           FROM actor_unavailability WHERE actor_id IN (${ph}) ORDER BY id`
      )
      .all(...actorIds);
  }

  return sha256(stableStringify({ sequences, self, otherSchedules, unavailability }));
}

// ---- 预演凭证落库（唯一允许的写操作：version_switch_previews 表本身） ----
function createSwitchPreview(rehearsal, targetVersionId, userId) {
  const plan = buildSwitchPlan(rehearsal, targetVersionId);
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const expiresAt = new Date(now + PREVIEW_TTL_MS).toISOString();
  const stateHash = switchStateHash(rehearsal);
  const resultHash = planResultHash(plan);
  const id = db
    .prepare(
      `INSERT INTO version_switch_previews
         (rehearsal_id, from_version_id, target_version_id, token, state_hash, result_hash, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      rehearsal.id,
      rehearsal.version_id,
      targetVersionId,
      token,
      stateHash,
      resultHash,
      userId,
      expiresAt
    ).lastInsertRowid;
  return {
    preview: {
      id,
      token,
      expiresAt,
      ttlSeconds: PREVIEW_TTL_MS / 1000,
      stateHash,
    },
    plan,
  };
}

// ---- 正式换版执行（沿用现有确认/日程/通知语义，同一事务） ----
function runVersionSwitchTx(rehearsal, targetVersionId, userId, extraInTx = null) {
  let needsAdjustmentSchedules = [];
  let switched = null;
  transaction(() => {
    const old = rehearsal.version_id;
    // 与原 /switch-version 完全一致的确认保留/作废规则
    const cast = db.prepare('SELECT * FROM rehearsal_cast WHERE rehearsal_id = ?').all(rehearsal.id);
    for (const c of cast) {
      const newScenes = new Set(
        db
          .prepare('SELECT DISTINCT scene_id FROM version_lines WHERE version_id = ? AND role_id = ?')
          .all(targetVersionId, c.role_id)
          .map((x) => x.scene_id)
      );
      const confirmations = db
        .prepare('SELECT * FROM confirmations WHERE rehearsal_id = ? AND role_id = ?')
        .all(rehearsal.id, c.role_id);
      for (const conf of confirmations) {
        if (!newScenes.has(conf.scene_id)) {
          db.prepare('DELETE FROM confirmations WHERE id = ?').run(conf.id);
          continue;
        }
        const oldHash = roleSceneHash(old, c.role_id, conf.scene_id);
        const newHash = roleSceneHash(targetVersionId, c.role_id, conf.scene_id);
        if (conf.content_hash !== oldHash || oldHash !== newHash) {
          db.prepare('DELETE FROM confirmations WHERE id = ?').run(conf.id);
        }
      }
    }
    db.prepare('UPDATE rehearsals SET version_id = ? WHERE id = ?').run(targetVersionId, rehearsal.id);
    db.prepare(
      'INSERT INTO rehearsal_version_log (rehearsal_id, from_version_id, to_version_id, actor_id) VALUES (?, ?, ?, ?)'
    ).run(rehearsal.id, old, targetVersionId, userId);
    // 惰性 require：避免与 rehearsals.js 形成模块加载期循环依赖
    const schedules = require('./schedules');
    needsAdjustmentSchedules = schedules.applySchedulesAfterVersionSwitch(rehearsal.id, targetVersionId);
    schedules.syncScheduleNotifications(rehearsal.id, 'version_switch', userId);
    if (extraInTx) extraInTx();
    switched = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(rehearsal.id);
  });
  return { switched, needsAdjustmentSchedules };
}

function executeVersionSwitch(rehearsal, targetVersionId, userId) {
  const { switched, needsAdjustmentSchedules } = runVersionSwitchTx(rehearsal, targetVersionId, userId);
  return { switched, needsAdjustmentSchedules };
}

function staleConflict(details) {
  return conflict(
    'PREVIEW_STALE',
    '预演之后排练版本、派角、相关日程或参与演员不可用记录已变化，请重新预演后再提交',
    details
  );
}

/**
 * 凭预演结果提交换版。
 * 顺序：令牌校验 -> 过期/已用校验 -> 状态指纹（过期拒绝）-> 冲突（整次不生效，返详情）
 *       -> 执行换版（同事务标记凭证已用）。
 */
function commitSwitchPreview(rehearsal, token, userId) {
  if (!token || typeof token !== 'string') throw badRequest('必须携带预演令牌 previewToken');
  const pv = db.prepare('SELECT * FROM version_switch_previews WHERE token = ?').get(token);
  if (!pv || pv.rehearsal_id !== rehearsal.id) {
    throw badRequest('预演令牌无效或不属于该排练，请重新预演');
  }
  if (pv.target_version_id !== rehearsal.version_id && pv.from_version_id !== rehearsal.version_id) {
    // 排练已换到其他版本
    throw staleConflict({ reason: 'rehearsal_version_changed' });
  }
  if (pv.consumed_at) {
    throw staleConflict({ reason: 'preview_consumed', consumedAt: pv.consumed_at });
  }
  if (Date.parse(pv.expires_at) <= Date.now()) {
    throw staleConflict({ reason: 'preview_expired', expiresAt: pv.expires_at });
  }
  if (pv.target_version_id === rehearsal.version_id) {
    throw badRequest('排练当前已固定在该版本');
  }

  // 重新预演（只读）：与凭证比对
  const plan = buildSwitchPlan(rehearsal, pv.target_version_id);
  const stateNow = switchStateHash(rehearsal);
  if (stateNow !== pv.state_hash) {
    throw staleConflict({
      reason: 'state_changed',
      expectedPreviewId: pv.id,
      fromVersionId: rehearsal.version_id,
      targetVersionId: pv.target_version_id,
    });
  }
  if (planResultHash(plan) !== pv.result_hash) {
    // 理论上 state_hash 已拦住；兜底，保证“成功提交与预演结果一致”
    throw staleConflict({ reason: 'result_changed', expectedPreviewId: pv.id });
  }
  if (plan.hasConflicts) {
    // 存在冲突：整次换版不生效，返回与预演一致的冲突详情
    const scheduleConflicts = plan.conflicts.filter((c) => c.type === 'schedule');
    const unavailabilityConflicts = plan.conflicts.filter((c) => c.type === 'unavailability');
    if (scheduleConflicts.length) {
      throw conflict(
        'SCHEDULE_CONFLICT',
        '预演显示换版后参与演员与其他未取消时段重叠，本次换版未生效',
        { conflicts: scheduleConflicts.map(({ type, ...rest }) => rest), previewToken: token }
      );
    }
    throw conflict(
      'UNAVAILABILITY_CONFLICT',
      '预演显示换版后参与演员与其登记的不可用时段相撞，本次换版未生效',
      { conflicts: unavailabilityConflicts.map(({ type, ...rest }) => rest), previewToken: token }
    );
  }

  // 执行换版并在同事务标记凭证已用（任一失败整体回滚，凭证仍可重试）
  const { switched, needsAdjustmentSchedules } = runVersionSwitchTx(
    rehearsal,
    pv.target_version_id,
    userId,
    () => {
      db.prepare('UPDATE version_switch_previews SET consumed_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        pv.id
      );
    }
  );

  return {
    switched,
    needsAdjustmentSchedules,
    previewId: pv.id,
    previewToken: token,
  };
}

module.exports = {
  buildSwitchPlan,
  createSwitchPreview,
  executeVersionSwitch,
  commitSwitchPreview,
  switchStateHash,
  planResultHash,
  PREVIEW_TTL_MS,
};
