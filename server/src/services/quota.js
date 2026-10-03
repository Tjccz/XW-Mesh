import { db } from '../db.js'

/** 套餐配额，自建版默认不限制 */
export const PLAN_QUOTA = {
  selfhost: {
    label: '自建版',
    networks: 999,
    nodes: 999,
    keys: 99,
    aclRules: 99,
    members: 99,
    trafficDays: 30,
  },
  pro: {
    label: '专业版',
    networks: 5,
    nodes: 50,
    keys: 20,
    aclRules: 5,
    members: 30,
    trafficDays: 7,
  },
  free: {
    label: '试用版',
    networks: 2,
    nodes: 20,
    keys: 5,
    aclRules: 1,
    members: 3,
    trafficDays: 1,
  },
}

export const quotaOf = (plan) => PLAN_QUOTA[plan] || PLAN_QUOTA.selfhost

export function usageOf(workspaceId) {
  const count = (sql, ...args) => db.prepare(sql).get(...args)?.c || 0
  return {
    networks: count('SELECT COUNT(*) AS c FROM networks WHERE workspace_id = ?', workspaceId),
    nodes: count('SELECT COUNT(*) AS c FROM nodes WHERE workspace_id = ?', workspaceId),
    keys: count(
      "SELECT COUNT(*) AS c FROM access_keys WHERE workspace_id = ? AND status = 'active'",
      workspaceId
    ),
    aclRules: count('SELECT COUNT(*) AS c FROM acl_rules WHERE workspace_id = ?', workspaceId),
    members: count('SELECT COUNT(*) AS c FROM users WHERE workspace_id = ?', workspaceId),
  }
}

const RESOURCE_LABEL = {
  networks: '网络',
  nodes: '节点',
  keys: '接入密钥',
  aclRules: '访问控制规则',
  members: '工作区成员',
}

/** 返回超限提示文本，未超限返回 null */
export function checkQuota(workspaceId, plan, resource, adding = 1) {
  const limit = quotaOf(plan)[resource]
  if (limit === undefined) return null
  const used = usageOf(workspaceId)[resource]
  if (used + adding > limit) {
    return `${RESOURCE_LABEL[resource] || resource}已达套餐上限（${used}/${limit}）`
  }
  return null
}

export function quotaOverview(workspaceId, plan) {
  const quota = quotaOf(plan)
  const used = usageOf(workspaceId)
  return Object.keys(used).map((key) => ({
    key,
    label: RESOURCE_LABEL[key] || key,
    used: used[key],
    limit: quota[key],
  }))
}
