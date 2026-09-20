import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://tremble-e.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 5;
const MAX_VERIFY_ATTEMPTS = 8;
const ALLOWED_UNIVERSITY_DOMAINS = new Set(["etu.unilim.fr", "unilim.fr"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function isAllowedUniversityEmail(email: string) {
  const match = email.match(/^([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)@([a-z0-9.-]+)$/i);
  if (!match) return false;
  return ALLOWED_UNIVERSITY_DOMAINS.has(match[2].toLowerCase());
}

function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  if (local.length <= 2) return `${local[0] || "*"}***@${domain}`;
  return `${local.slice(0, 2)}${"*".repeat(Math.min(8, Math.max(3, local.length - 2)))}@${domain}`;
}

function authCode(error: unknown) {
  return String((error as { code?: string } | null)?.code || "");
}

function authStatus(error: unknown) {
  return Number((error as { status?: number } | null)?.status || 0);
}

function isExistingAuthUserError(error: unknown) {
  const code = authCode(error);
  return code === "email_exists" || code === "user_already_exists";
}

async function cleanupExpiredRequests(admin: ReturnType<typeof createClient>) {
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("ade_email_verification_codes")
    .select("user_id,shadow_auth_user_id")
    .lt("expires_at", now)
    .limit(40);
  if (error || !data?.length) return;

  for (const row of data) {
    if (row.shadow_auth_user_id) {
      try {
        await admin.auth.admin.deleteUser(row.shadow_auth_user_id);
      } catch (error) {
        console.warn("Expired ADE OTP shadow cleanup failed", row.shadow_auth_user_id, error);
      }
    }
  }

  const userIds = data.map(row => row.user_id).filter(Boolean);
  if (userIds.length) {
    await admin.from("ade_email_verification_codes").delete().in("user_id", userIds);
  }
}

async function createTemporaryAuthTarget(
  admin: ReturnType<typeof createClient>,
  email: string,
  ownerUserId: string,
) {
  const password = `${crypto.randomUUID()}-${crypto.randomUUID()}-Aa1!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      ade_otp_shadow: true,
      ade_owner_user_id: ownerUserId,
      ade_created_at: new Date().toISOString(),
    },
  });

  if (!error && data?.user?.id) return data.user.id;
  if (isExistingAuthUserError(error)) return null;
  throw error || new Error("AUTH_TARGET_CREATION_FAILED");
}

async function deleteShadowUser(admin: ReturnType<typeof createClient>, userId: string | null | undefined) {
  if (!userId) return;
  try {
    await admin.auth.admin.deleteUser(userId);
  } catch (error) {
    console.warn("ADE OTP shadow deletion failed", userId, error);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (request.method !== "POST") return json({ ok: false, code: "METHOD_NOT_ALLOWED" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return json({ ok: false, code: "SERVER_NOT_CONFIGURED" }, 500);
  }

  const authorization = request.headers.get("Authorization") || "";
  const accessToken = authorization.replace(/^Bearer\s+/i, "");
  if (!accessToken) return json({ ok: false, code: "ACCOUNT_REQUIRED" }, 401);

  const siteAuth = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: authData, error: authError } = await siteAuth.auth.getUser(accessToken);
  if (authError || !authData.user) return json({ ok: false, code: "ACCOUNT_REQUIRED" }, 401);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const otpAuth = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  let body: { action?: string; email?: string; code?: string } = {};
  try { body = await request.json(); } catch {}

  const userId = authData.user.id;
  const existingVerification = await admin
    .from("ade_verifications")
    .select("verified_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (existingVerification.data?.verified_at) {
    return json({ ok: true, code: "ALREADY_VERIFIED" });
  }

  if (body.action === "send_code") {
    await cleanupExpiredRequests(admin);

    const email = normalizeEmail(body.email);
    if (!isAllowedUniversityEmail(email)) {
      return json({
        ok: false,
        code: "INVALID_UNIVERSITY_EMAIL",
        domains: ["etu.unilim.fr", "unilim.fr"],
      }, 400);
    }

    const claimed = await admin
      .from("ade_student_identities")
      .select("user_id")
      .eq("student_email", email)
      .maybeSingle();
    if (claimed.data?.user_id && claimed.data.user_id !== userId) {
      return json({ ok: false, code: "EMAIL_ALREADY_USED" }, 409);
    }

    const now = Date.now();
    const { data: current, error: currentError } = await admin
      .from("ade_email_verification_codes")
      .select("student_email,shadow_auth_user_id,last_sent_at,window_started_at,sends_in_window")
      .eq("user_id", userId)
      .maybeSingle();
    if (currentError) {
      console.error("OTP lookup failed", currentError);
      return json({ ok: false, code: "REQUEST_LOOKUP_FAILED" }, 500);
    }

    if (current?.last_sent_at) {
      const lastSent = Date.parse(current.last_sent_at);
      if (Number.isFinite(lastSent) && now - lastSent < RESEND_COOLDOWN_MS) {
        const retry = Math.max(1, Math.ceil((RESEND_COOLDOWN_MS - (now - lastSent)) / 1000));
        return json({ ok: false, code: "WAIT_BEFORE_RESEND", retry_after_seconds: retry }, 429);
      }
    }

    let windowStarted = current?.window_started_at ? Date.parse(current.window_started_at) : now;
    let sendsInWindow = Number(current?.sends_in_window || 0);
    if (!Number.isFinite(windowStarted) || now - windowStarted >= RATE_WINDOW_MS) {
      windowStarted = now;
      sendsInWindow = 0;
    }
    if (sendsInWindow >= MAX_SENDS_PER_WINDOW) {
      const retry = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - windowStarted)) / 1000));
      return json({ ok: false, code: "RATE_LIMITED", retry_after_seconds: retry }, 429);
    }

    let shadowAuthUserId: string | null = current?.shadow_auth_user_id || null;

    // Si l'utilisateur change d'adresse avant validation, on nettoie l'utilisateur Auth temporaire précédent.
    if (current?.student_email && current.student_email !== email && shadowAuthUserId) {
      await deleteShadowUser(admin, shadowAuthUserId);
      shadowAuthUserId = null;
    }

    try {
      if (!shadowAuthUserId) {
        shadowAuthUserId = await createTemporaryAuthTarget(admin, email, userId);
      }
    } catch (error) {
      console.error("Temporary Auth target creation failed", error);
      return json({ ok: false, code: "AUTH_TARGET_CREATION_FAILED", auth_code: authCode(error) }, 500);
    }

    // On utilise le mailer de Supabase Auth, exactement le même service que pour les mails d'inscription.
    const { error: sendError } = await otpAuth.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });

    if (sendError) {
      // Si nous venons de créer un utilisateur temporaire et que l'envoi échoue, on ne le laisse pas traîner.
      if (!current?.shadow_auth_user_id && shadowAuthUserId) await deleteShadowUser(admin, shadowAuthUserId);
      const code = authCode(sendError);
      console.error("Supabase Auth OTP send failed", code, authStatus(sendError), sendError.message);
      if (code === "email_address_not_authorized") {
        return json({ ok: false, code: "SUPABASE_EMAIL_NOT_AUTHORIZED" }, 502);
      }
      if (authStatus(sendError) === 429) {
        return json({ ok: false, code: "SUPABASE_EMAIL_RATE_LIMIT", retry_after_seconds: 60 }, 429);
      }
      return json({ ok: false, code: "EMAIL_SEND_FAILED", auth_code: code }, 502);
    }

    const expiresAt = new Date(now + OTP_TTL_MS).toISOString();
    const { error: upsertError } = await admin
      .from("ade_email_verification_codes")
      .upsert({
        user_id: userId,
        student_email: email,
        shadow_auth_user_id: shadowAuthUserId,
        expires_at: expiresAt,
        last_sent_at: new Date(now).toISOString(),
        window_started_at: new Date(windowStarted).toISOString(),
        sends_in_window: sendsInWindow + 1,
        attempts: 0,
        updated_at: new Date(now).toISOString(),
      }, { onConflict: "user_id" });
    if (upsertError) {
      console.error("OTP request storage failed", upsertError);
      if (!current?.shadow_auth_user_id && shadowAuthUserId) await deleteShadowUser(admin, shadowAuthUserId);
      return json({ ok: false, code: "REQUEST_CREATION_FAILED" }, 500);
    }

    return json({
      ok: true,
      code: "CODE_SENT",
      masked_email: maskEmail(email),
      expires_in_seconds: OTP_TTL_MS / 1000,
      resend_after_seconds: RESEND_COOLDOWN_MS / 1000,
    });
  }

  if (body.action === "verify_code") {
    const code = String(body.code || "").replace(/\D/g, "");
    if (!/^\d{6}$/.test(code)) return json({ ok: false, code: "INVALID_CODE_FORMAT" }, 400);

    const { data: pending, error: pendingError } = await admin
      .from("ade_email_verification_codes")
      .select("student_email,shadow_auth_user_id,expires_at,attempts")
      .eq("user_id", userId)
      .maybeSingle();
    if (pendingError) {
      console.error("OTP verification lookup failed", pendingError);
      return json({ ok: false, code: "REQUEST_LOOKUP_FAILED" }, 500);
    }
    if (!pending) return json({ ok: false, code: "NO_ACTIVE_CODE" }, 404);

    if (Date.parse(pending.expires_at) <= Date.now()) {
      await admin.from("ade_email_verification_codes").delete().eq("user_id", userId);
      await deleteShadowUser(admin, pending.shadow_auth_user_id);
      return json({ ok: false, code: "CODE_EXPIRED" }, 410);
    }

    const attempts = Number(pending.attempts || 0);
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await admin.from("ade_email_verification_codes").delete().eq("user_id", userId);
      await deleteShadowUser(admin, pending.shadow_auth_user_id);
      return json({ ok: false, code: "TOO_MANY_ATTEMPTS" }, 429);
    }

    const { data: otpData, error: otpError } = await otpAuth.auth.verifyOtp({
      email: pending.student_email,
      token: code,
      type: "email",
    });

    if (otpError || !otpData?.user) {
      const nextAttempts = attempts + 1;
      await admin
        .from("ade_email_verification_codes")
        .update({ attempts: nextAttempts, updated_at: new Date().toISOString() })
        .eq("user_id", userId);

      const errorCode = authCode(otpError);
      const expired = ["otp_expired", "flow_state_expired"].includes(errorCode);
      if (expired) {
        await admin.from("ade_email_verification_codes").delete().eq("user_id", userId);
        await deleteShadowUser(admin, pending.shadow_auth_user_id);
        return json({ ok: false, code: "CODE_EXPIRED" }, 410);
      }

      return json({
        ok: false,
        code: nextAttempts >= MAX_VERIFY_ATTEMPTS ? "TOO_MANY_ATTEMPTS" : "WRONG_CODE",
        attempts_remaining: Math.max(0, MAX_VERIFY_ATTEMPTS - nextAttempts),
      }, nextAttempts >= MAX_VERIFY_ATTEMPTS ? 429 : 400);
    }

    if (normalizeEmail(otpData.user.email) !== normalizeEmail(pending.student_email)) {
      console.error("OTP verified for an unexpected email", otpData.user.email, pending.student_email);
      return json({ ok: false, code: "EMAIL_MISMATCH" }, 409);
    }

    const claimed = await admin
      .from("ade_student_identities")
      .select("user_id")
      .eq("student_email", pending.student_email)
      .maybeSingle();
    if (claimed.data?.user_id && claimed.data.user_id !== userId) {
      await admin.from("ade_email_verification_codes").delete().eq("user_id", userId);
      await deleteShadowUser(admin, pending.shadow_auth_user_id);
      return json({ ok: false, code: "EMAIL_ALREADY_USED" }, 409);
    }

    const verifiedAt = new Date().toISOString();
    const identityResult = await admin.from("ade_student_identities").upsert({
      user_id: userId,
      student_email: pending.student_email,
      verified_at: verifiedAt,
    }, { onConflict: "user_id" });
    if (identityResult.error) {
      console.error("University identity storage failed", identityResult.error);
      return json({ ok: false, code: "VERIFICATION_SAVE_FAILED" }, 500);
    }

    const verificationResult = await admin.from("ade_verifications").upsert({
      user_id: userId,
      provider: "unilim-email-otp",
      verified_at: verifiedAt,
    }, { onConflict: "user_id" });
    if (verificationResult.error) {
      console.error("ADE verification storage failed", verificationResult.error);
      return json({ ok: false, code: "VERIFICATION_SAVE_FAILED" }, 500);
    }

    await admin.from("ade_email_verification_codes").delete().eq("user_id", userId);

    // Un utilisateur Auth temporaire n'est utile que pour faire passer le mail par Supabase Auth.
    // Une fois l'adresse prouvée, on le supprime immédiatement. La vraie liaison est ade_student_identities -> compte du site.
    const verifiedUserIsShadow = Boolean(otpData.user.user_metadata?.ade_otp_shadow === true);
    if (pending.shadow_auth_user_id || verifiedUserIsShadow) {
      await deleteShadowUser(admin, pending.shadow_auth_user_id || (verifiedUserIsShadow ? otpData.user.id : null));
    }

    return json({ ok: true, code: "VERIFIED", university_email: pending.student_email });
  }

  return json({ ok: false, code: "INVALID_ACTION" }, 400);
});
