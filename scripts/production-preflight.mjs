const backendUrl = process.env.BACKEND_URL || "http://127.0.0.1:3000";

let response;
let payload;
try {
  response = await fetch(`${backendUrl.replace(/\/$/, "")}/ready`);
  payload = await response.json();
} catch (error) {
  console.error(`Production preflight could not reach ${backendUrl}`);
  console.error(error instanceof Error ? error.message : "Invalid readiness response");
  process.exit(1);
}
const checks = payload.checks || {};
const required = [
  "database",
  "publicDomain",
  "webOrigins",
  "authSecrets",
  "adminApiKey",
  "trustedProxy",
  "bunny",
  "reputationChecks",
  "reputationFailClosed",
  "payment",
  "recurringPlans",
];
const failed = required.filter((name) => checks[name] !== true);

if (payload.environment !== "production") failed.push("NODE_ENV=production");

if (failed.length) {
  console.error(`Production preflight failed for ${backendUrl}`);
  console.error(`Missing or invalid gates: ${failed.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`Production preflight passed for ${backendUrl}`);
}
