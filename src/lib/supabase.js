import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null

export async function syncPointsToCloud(userId, points) {
  if (!supabase || !userId || !points.length) return
  const rows = points.map(p => ({ id: p.id, user_id: userId, data: p, updated_at: new Date().toISOString() }))
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from('points').upsert(rows.slice(i, i + 200))
    if (error) throw error
  }
}

export async function loadPointsFromCloud(userId) {
  if (!supabase || !userId) return null
  const allRows = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('points')
      .select('data')
      .eq('user_id', userId)
      .range(from, from + PAGE - 1)
    if (error) throw error
    allRows.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return allRows.map(row => row.data)
}

export async function syncSettingsToCloud(userId, settings) {
  if (!supabase || !userId) return
  const { error } = await supabase.from('user_settings').upsert(
    { user_id: userId, ...settings, updated_at: new Date().toISOString() }
  )
  if (error) throw error
}

export async function loadSettingsFromCloud(userId) {
  if (!supabase || !userId) return null
  const { data } = await supabase.from('user_settings').select('*').eq('user_id', userId).maybeSingle()
  return data
}

export async function trackEvent(userId, eventName, properties = {}) {
  if (!supabase) return
  try {
    let sid = sessionStorage.getItem('tr_sid')
    if (!sid) { sid = Math.random().toString(36).slice(2); sessionStorage.setItem('tr_sid', sid) }
    await supabase.from('analytics_events').insert({
      user_id: userId || null,
      session_id: sid,
      event_name: eventName,
      properties,
    })
  } catch (_) {}
}

export async function loadAnalyticsData() {
  if (!supabase) return null
  const [eventsRes, usersRes] = await Promise.all([
    supabase.from('analytics_events').select('event_name, user_id, created_at').order('created_at', { ascending: false }).limit(2000),
    supabase.from('user_settings').select('user_id, updated_at'),
  ])
  return { events: eventsRes.data || [], users: usersRes.data || [] }
}
