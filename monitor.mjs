const portalUrl = String(process.env.PORTAL_URL || "https://ksaprojectportal.vercel.app").replace(/\/$/, "");
const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const syntheticEmail = String(process.env.PORTAL_SYNTHETIC_EMAIL || "").trim().toLowerCase();
const syntheticPassword = process.env.PORTAL_SYNTHETIC_PASSWORD;
const metricsSecretKey = process.env.SUPABASE_METRICS_SECRET_KEY;
const timeoutMs = Number(process.env.MONITOR_REQUEST_TIMEOUT_MS || 15_000);

const thresholds = {
  cpuPct: Number(process.env.SUPABASE_CPU_ALERT_PCT || 85),
  connectionPct: Number(process.env.SUPABASE_CONNECTION_ALERT_PCT || 80),
  databaseBytes: Number(process.env.SUPABASE_DATABASE_ALERT_BYTES || 419_430_400),
  storageBytes: Number(process.env.SUPABASE_STORAGE_ALERT_BYTES || 858_993_459),
  apiErrorPct: Number(process.env.SUPABASE_API_ERROR_ALERT_PCT || 10),
};

function required(value, label) {
  if (!value) throw new Error(`${label} is not configured.`);
  return value;
}

async function timedFetch(url, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    ...options,
  });
  return { response, durationMs: Math.round(performance.now() - startedAt) };
}

function parsePrometheus(text) {
  const samples = [];
  String(text || "").split("\n").forEach((line) => {
    if (!line || line.startsWith("#")) return;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([^\s]+)$/);
    if (!match) return;
    const labels = {};
    String(match[2] || "").replace(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g, (_, key, value) => {
      labels[key] = value.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
      return "";
    });
    const value = Number(match[3]);
    if (Number.isFinite(value)) samples.push({ name: match[1], labels, value });
  });
  return samples;
}

function metricSum(samples, name, predicate = () => true) {
  return samples
    .filter((sample) => sample.name === name && predicate(sample.labels))
    .reduce((sum, sample) => sum + sample.value, 0);
}

function metricDelta(before, after, name, predicate = () => true) {
  return Math.max(0, metricSum(after, name, predicate) - metricSum(before, name, predicate));
}

async function fetchMetrics() {
  const authorization = Buffer.from(`service_role:${metricsSecretKey}`).toString("base64");
  const { response } = await timedFetch(`${supabaseUrl}/customer/v1/privileged/metrics`, {
    headers: { Authorization: `Basic ${authorization}` },
  });
  if (!response.ok) throw new Error(`Supabase Metrics API returned HTTP ${response.status}.`);
  return parsePrometheus(await response.text());
}

async function checkPublicEndpoints(results) {
  const portal = await timedFetch(portalUrl, { headers: { "User-Agent": "KSA-Portal-Monitor/1.0" } });
  if (!portal.response.ok) throw new Error(`Vercel portal returned HTTP ${portal.response.status}.`);
  const portalBody = await portal.response.text();
  if (!portalBody.includes('id="root"')) throw new Error("Vercel portal response did not contain the application root.");
  results.push({ check: "vercel_page", ok: true, durationMs: portal.durationMs });

  const authHealth = await timedFetch(`${supabaseUrl}/auth/v1/health`, { headers: { apikey: supabaseAnonKey } });
  if (!authHealth.response.ok) throw new Error(`Supabase Auth health returned HTTP ${authHealth.response.status}.`);
  results.push({ check: "supabase_auth", ok: true, durationMs: authHealth.durationMs });
}

async function checkAuthenticatedMember(results) {
  const signIn = await timedFetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: supabaseAnonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: syntheticEmail, password: syntheticPassword }),
  });
  if (!signIn.response.ok) throw new Error(`Synthetic member sign-in returned HTTP ${signIn.response.status}.`);
  const session = await signIn.response.json();
  if (!session?.access_token) throw new Error("Synthetic member sign-in returned no access token.");
  const authHeaders = { apikey: supabaseAnonKey, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" };
  const startedAt = performance.now();

  try {
    const roleCheck = await timedFetch(`${supabaseUrl}/rest/v1/rpc/current_user_role`, { method: "POST", headers: authHeaders, body: "{}" });
    if (!roleCheck.response.ok) throw new Error(`Synthetic role check returned HTTP ${roleCheck.response.status}.`);
    if (await roleCheck.response.json() !== "member") throw new Error("Synthetic identity is not a member.");

    const memberUrl = new URL(`${supabaseUrl}/rest/v1/team_members`);
    memberUrl.searchParams.set("select", "id,portal_role,is_service_account");
    memberUrl.searchParams.set("contact", `ilike.${syntheticEmail}`);
    const identityCheck = await timedFetch(memberUrl, { headers: authHeaders });
    if (!identityCheck.response.ok) throw new Error(`Synthetic identity check returned HTTP ${identityCheck.response.status}.`);
    const [identity] = await identityCheck.response.json();
    if (!identity || identity.portal_role !== "member" || identity.is_service_account !== true) {
      throw new Error("Synthetic identity is not a low-permission service member.");
    }

    const snapshotCheck = await timedFetch(`${supabaseUrl}/rest/v1/rpc/portal_monitoring_snapshot`, { method: "POST", headers: authHeaders, body: "{}" });
    if (!snapshotCheck.response.ok) throw new Error(`Authenticated database check returned HTTP ${snapshotCheck.response.status}.`);
    const snapshot = await snapshotCheck.response.json();
    results.push({
      check: "authenticated_member",
      ok: true,
      durationMs: Math.round(performance.now() - startedAt),
      databaseBytes: Number(snapshot.database_size_bytes || 0),
      storageBytes: Number(snapshot.storage_size_bytes || 0),
      activeConnections: Number(snapshot.active_connections || 0),
      maxConnections: Number(snapshot.max_connections || 0),
    });
    if (Number(snapshot.database_size_bytes || 0) >= thresholds.databaseBytes) throw new Error("Supabase database storage alert threshold was reached.");
    if (Number(snapshot.storage_size_bytes || 0) >= thresholds.storageBytes) throw new Error("Supabase object storage alert threshold was reached.");
  } finally {
    await fetch(`${supabaseUrl}/auth/v1/logout`, { method: "POST", headers: authHeaders }).catch(() => undefined);
  }
}

async function checkSupabaseResources(results) {
  const before = await fetchMetrics();
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const after = await fetchMetrics();
  const totalCpu = metricDelta(before, after, "node_cpu_seconds_total", (labels) => labels.service_type === "db");
  const idleCpu = metricDelta(before, after, "node_cpu_seconds_total", (labels) => labels.service_type === "db" && labels.mode === "idle");
  const cpuPct = totalCpu > 0 ? Math.max(0, Math.min(100, (1 - idleCpu / totalCpu) * 100)) : 0;
  const maximumConnections = metricSum(after, "max_connections_connection_count");
  const activeConnections = metricSum(after, "connection_stats_connection_count") + metricSum(after, "direct_connection_stats_connection_count");
  const connectionPct = maximumConnections > 0 ? activeConnections / maximumConnections * 100 : 0;
  const apiRequests = metricDelta(before, after, "http_status_codes_total");
  const apiErrors = metricDelta(before, after, "http_status_codes_total", (labels) => Number(labels.code || 0) >= 500);
  const apiErrorPct = apiRequests > 0 ? apiErrors / apiRequests * 100 : 0;
  results.push({ check: "supabase_resources", ok: true, cpuPct: Number(cpuPct.toFixed(1)), connectionPct: Number(connectionPct.toFixed(1)), apiErrorPct: Number(apiErrorPct.toFixed(1)) });
  if (cpuPct >= thresholds.cpuPct) throw new Error(`Supabase CPU reached ${cpuPct.toFixed(1)}%.`);
  if (connectionPct >= thresholds.connectionPct) throw new Error(`Supabase connections reached ${connectionPct.toFixed(1)}%.`);
  if (apiRequests >= 5 && apiErrorPct >= thresholds.apiErrorPct) throw new Error(`Supabase API 5xx rate reached ${apiErrorPct.toFixed(1)}%.`);
}

required(supabaseUrl, "SUPABASE_URL");
required(supabaseAnonKey, "SUPABASE_ANON_KEY");
required(syntheticEmail, "PORTAL_SYNTHETIC_EMAIL");
required(syntheticPassword, "PORTAL_SYNTHETIC_PASSWORD");
required(metricsSecretKey, "SUPABASE_METRICS_SECRET_KEY");

const results = [];
try {
  await checkPublicEndpoints(results);
  await checkAuthenticatedMember(results);
  await checkSupabaseResources(results);
  console.log(JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), results }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, checkedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "Unknown monitoring failure", results }));
  process.exitCode = 1;
}
