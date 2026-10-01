import type {FastifyInstance} from "fastify";
import {totpCodeAt} from "../../src/operations/accounts.js";

export async function loginPlatform(app: FastifyInstance, username: string, password: string, origin: string) {
  const passwordResult = await app.inject({method: "POST", url: "/workspace/api/auth/login", headers: {origin}, payload: {username, password}});
  if (passwordResult.statusCode !== 200) throw new Error("platform_password_login_failed:" + passwordResult.body);
  const challenge = passwordResult.json().mfa;
  if (!challenge?.challenge_token) throw new Error("platform_mfa_challenge_missing");
  if (!challenge.secret) throw new Error("platform_mfa_test_requires_enrollment_secret");
  const verified = await app.inject({method: "POST", url: "/workspace/api/auth/mfa/verify", headers: {origin},
    payload: {challenge_token: challenge.challenge_token, code: totpCodeAt(challenge.secret)}});
  if (verified.statusCode !== 200) throw new Error("platform_mfa_verify_failed:" + verified.body);
  return verified;
}
