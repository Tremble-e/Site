import { createClient } from "npm:@supabase/supabase-js@2";

const CAS_BASE_URL = "https://cas.unilim.fr/cas";
const DEFAULT_SITE_URL = "https://tremble-e.github.io/Site/#planning";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://tremble-e.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function redirect(url: string) {
  return new Response(null, { status: 302, headers: { Location: url } });
}

function resultUrl(raw: string, result: "verified" | "failed") {
  const fallback = Deno.env.get("PLANILIM_SITE_URL") || DEFAULT_SITE_URL;
  let target: URL;
  try {
    target = new URL(raw || fallback);
    const allowed = new URL(fallback);
    if (target.origin !== allowed.origin || !target.pathname.startsWith(allowed.pathname)) {
      target = allowed;
    }
  } catch {
    target = new URL(fallback);
  }
  target.searchParams.set("ade", result);
  if (!target.hash) target.hash = "planning";
  return target.toString();
}

function casSucceeded(xml: string) {
  return /<(?:\w+:)?authenticationSuccess(?:\s|>)/i.test(xml) &&
    !/<(?:\w+:)?authenticationFailure(?:\s|>)/i.test(xml);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return json({ ok: false, code: "SERVER_NOT_CONFIGURED" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const url = new URL(request.url);

  if (request.method === "GET" && url.searchParams.get("mode") === "callback") {
    const state = url.searchParams.get("state") || "";
    const ticket = url.searchParams.get("ticket") || "";
    const { data: pending } = await admin
      .from("ade_verification_requests")
      .select("state,user_id,service_url,return_url,expires_at")
      .eq("state", state)
      .maybeSingle();

    if (!pending || !ticket || Date.parse(pending.expires_at) < Date.now()) {
      if (pending?.state) await admin.from("ade_verification_requests").delete().eq("state", pending.state);
      return redirect(resultUrl(pending?.return_url || DEFAULT_SITE_URL, "failed"));
    }

    const validationUrl = new URL(`${CAS_BASE_URL}/serviceValidate`);
    validationUrl.searchParams.set("service", pending.service_url);
    validationUrl.searchParams.set("ticket", ticket);

    try {
      const casResponse = await fetch(validationUrl, {
        method: "GET",
        headers: { Accept: "application/xml, text/xml" },
      });
      const xml = await casResponse.text();
      if (!casResponse.ok || !casSucceeded(xml)) {
        await admin.from("ade_verification_requests").delete().eq("state", pending.state);
        return redirect(resultUrl(pending.return_url, "failed"));
      }

      const { error } = await admin.from("ade_verifications").upsert({
        user_id: pending.user_id,
        provider: "unilim-cas",
        verified_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      await admin.from("ade_verification_requests").delete().eq("state", pending.state);
      if (error) throw error;
      return redirect(resultUrl(pending.return_url, "verified"));
    } catch (error) {
      console.error("CAS validation failed", error);
      await admin.from("ade_verification_requests").delete().eq("state", pending.state);
      return redirect(resultUrl(pending.return_url, "failed"));
    }
  }

  if (request.method !== "POST") return json({ ok: false, code: "METHOD_NOT_ALLOWED" }, 405);

  const authorization = request.headers.get("Authorization") || "";
  const accessToken = authorization.replace(/^Bearer\s+/i, "");
  if (!accessToken) return json({ ok: false, code: "ACCOUNT_REQUIRED" }, 401);

  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await authClient.auth.getUser(accessToken);
  if (authError || !authData.user) return json({ ok: false, code: "ACCOUNT_REQUIRED" }, 401);

  let body: { action?: string; returnUrl?: string } = {};
  try { body = await request.json(); } catch {}
  if (body.action !== "start") return json({ ok: false, code: "INVALID_ACTION" }, 400);

  const existing = await admin
    .from("ade_verifications")
    .select("verified_at")
    .eq("user_id", authData.user.id)
    .maybeSingle();
  if (existing.data) return json({ ok: true, code: "ALREADY_VERIFIED" });

  const state = crypto.randomUUID();
  const functionUrl = `${supabaseUrl}/functions/v1/verify-ade`;
  const serviceUrl = `${functionUrl}?mode=callback&state=${encodeURIComponent(state)}`;
  const returnUrl = resultUrl(body.returnUrl || DEFAULT_SITE_URL, "verified").replace(/[?&]ade=verified/, "");
  const { error: insertError } = await admin.from("ade_verification_requests").insert({
    state,
    user_id: authData.user.id,
    service_url: serviceUrl,
    return_url: returnUrl,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (insertError) {
    console.error("Verification request creation failed", insertError);
    return json({ ok: false, code: "REQUEST_CREATION_FAILED" }, 500);
  }

  const loginUrl = new URL(`${CAS_BASE_URL}/login`);
  loginUrl.searchParams.set("service", serviceUrl);
  return json({ ok: true, code: "CAS_REDIRECT_READY", url: loginUrl.toString() });
});
