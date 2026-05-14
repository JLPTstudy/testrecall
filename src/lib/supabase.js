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
  const { data, error } = await supabase.from('points').select('data').eq('user_id', userId)
  if (error) throw error
  return data.map(row => row.data)
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
