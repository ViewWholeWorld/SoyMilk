// /api/admin/*: queries are GET, creation POST, edits PATCH, business commands POST.
// Every route goes through adminHandler (session + CSRF); manual changes are audited in the modules.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { actorOf } from "@aihot/backend/admin/auth";

import { importSelectBenchRun, listSelectBenchRuns, selectBenchRun } from "@aihot/backend/admin/selectbench";
import { modelAssignments, modelsOverview, switchModel } from "@aihot/backend/admin/models";
import { modelStats, modelStatsOptions } from "@aihot/backend/admin/model-stats";
import { createModelSupplier, listModelSuppliers } from "@aihot/backend/admin/model-suppliers";
import { activateConnection, cancelLogin, codexModels, codexStatus, connectCodex, disconnectCodex, loginStatus, modelConfiguration, removeConnection, saveConnection } from "@aihot/backend/admin/model-config";
import { sha256 } from "@aihot/backend/lib/ids";

import { contentChain, overrideFields, rerun, searchContent, setSeoIndexed, setVisibility } from "@aihot/backend/admin/content";
import { requeueFailedArticles, runsOverview } from "@aihot/backend/admin/runs";
import { dismissFollowUp, restoreFollowUp } from "@aihot/backend/operations/alerts";
import { settingsOverview, updateBudget } from "@aihot/backend/admin/settings";
import { createSource, fetchNow, listSources, previewSource, previewStoredSource, sourceDetail, updateSource } from "@aihot/backend/admin/sources";
import { navCounts } from "@aihot/backend/admin/navigation";
import { listAudit } from "@aihot/backend/audit";
import { detachFromFact, mergeStories } from "@aihot/backend/events/corrections";
import { releaseReceipt } from "@aihot/backend/operations/recover";
import { sendProblem } from "../http/respond.ts";
import { adminHandler } from "./admin-auth.ts";

type Q = Record<string, string | undefined>;
const q = (req: FastifyRequest) => req.query as Q;
const body = <T = Record<string, unknown>>(req: FastifyRequest) => (req.body ?? {}) as T;
const param = (req: FastifyRequest, name: string) => (req.params as Record<string, string>)[name]!;
const notFound = (req: FastifyRequest, reply: FastifyReply) => sendProblem(req, reply, { status: 404, code: "not_found", detail: "Not found." });
const orNotFound = <T>(req: FastifyRequest, reply: FastifyReply, value: T | null) => (value === null || value === undefined ? notFound(req, reply) : value);
const page = (req: FastifyRequest) => Math.max(1, Number(q(req).page) || 1);

export function registerAdmin(app: FastifyInstance) {
  app.get("/api/admin/model-config", adminHandler(async () => modelConfiguration()));
  app.get("/api/admin/model-assignments", adminHandler(async () => modelAssignments()));
  app.get("/api/admin/model-suppliers", adminHandler(async () => listModelSuppliers()));
  app.post("/api/admin/model-suppliers", adminHandler(async (req) => createModelSupplier(req.body)));
  app.get("/api/admin/model-stats", adminHandler(async (req) => modelStats(q(req))));
  app.get("/api/admin/model-stats/options", adminHandler(async () => modelStatsOptions()));
  app.post("/api/admin/model-config/connections", adminHandler(async (req, _reply, admin) => saveConnection(req.body, actorOf(admin))));
  app.post("/api/admin/model-config/active", adminHandler(async (req, _reply, admin) => activateConnection(req.body, actorOf(admin))));
  app.delete("/api/admin/model-config/connections/:id", adminHandler(async (req, _reply, admin) => removeConnection(param(req, "id"), actorOf(admin))));
  app.get("/api/admin/model-config/codex", adminHandler(async (_req, _reply, admin) => codexStatus(sha256(admin.csrf))));
  app.post("/api/admin/model-config/codex/login", adminHandler(async (req, _reply, admin) => connectCodex(sha256(admin.csrf), actorOf(admin), req.body ?? {})));
  app.get("/api/admin/model-config/codex/login/:id", adminHandler(async (req, _reply, admin) => loginStatus(sha256(admin.csrf), param(req, "id"), actorOf(admin))));
  app.post("/api/admin/model-config/codex/login/:id/cancel", adminHandler(async (req, _reply, admin) => cancelLogin(sha256(admin.csrf), param(req, "id"), actorOf(admin))));
  app.post("/api/admin/model-config/codex/logout", adminHandler(async (_req, _reply, admin) => disconnectCodex(actorOf(admin))));
  app.post("/api/admin/model-config/codex/models", adminHandler(async () => codexModels()));
  // Sources (F18)
  app.get("/api/admin/sources", adminHandler(async (req) => {
    const f = q(req);
    return listSources({ q: f.q, kind: f.kind, health: f.health, mode: f.mode, enabled: f.enabled as "true" | "false" | undefined, page: page(req) });
  }));
  app.post("/api/admin/sources", adminHandler(async (req, _reply, admin) => createSource(body(req), actorOf(admin))));
  app.post("/api/admin/sources/preview", adminHandler(async (req) => previewSource(body(req) as never)));
  app.get("/api/admin/sources/:id", adminHandler(async (req, reply) => orNotFound(req, reply, await sourceDetail(param(req, "id")))));
  app.patch("/api/admin/sources/:id", adminHandler(async (req, reply, admin) => {
    const b = body<{ patch: unknown; version: string; reason?: string }>(req);
    return orNotFound(req, reply, await updateSource(param(req, "id"), b, actorOf(admin)));
  }));
  app.post("/api/admin/sources/:id/preview", adminHandler(async (req, reply) => orNotFound(req, reply, await previewStoredSource(param(req, "id")))));
  app.post("/api/admin/sources/:id/fetch", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await fetchNow(param(req, "id"), actorOf(admin)))));

  // Content and events (F19)
  app.get("/api/admin/content", adminHandler(async (req) => ({ rows: await searchContent(q(req).q ?? "") })));
  app.get("/api/admin/content/:id", adminHandler(async (req, reply) => orNotFound(req, reply, await contentChain(param(req, "id")))));
  app.post("/api/admin/content/:id/visibility", adminHandler(async (req, _reply, admin) => setVisibility(param(req, "id"), body(req) as never, actorOf(admin))));
  app.post("/api/admin/content/:id/seo", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await setSeoIndexed(param(req, "id"), body(req) as never, actorOf(admin)))));
  app.post("/api/admin/content/:id/override", adminHandler(async (req, _reply, admin) => overrideFields(param(req, "id"), body(req) as never, actorOf(admin))));
  app.post("/api/admin/content/:id/rerun", adminHandler(async (req, reply, admin) => {
    const b = body<{ step: "extract" | "analyze" | "group" }>(req);
    const requestId = String(req.headers["idempotency-key"] ?? "");
    return orNotFound(req, reply, await rerun(param(req, "id"), b.step, requestId, actorOf(admin)));
  }));
  app.post("/api/admin/content/:id/detach", adminHandler(async (req, _reply, admin) => detachFromFact(param(req, "id"), String(body(req).reason ?? ""), actorOf(admin))));
  app.post("/api/admin/stories/merge", adminHandler(async (req, _reply, admin) => {
    const b = body<{ from: number; into: number; reason: string }>(req);
    return mergeStories(Number(b.from), Number(b.into), b.reason, actorOf(admin));
  }));

  // Runs (F20)
  app.get("/api/admin/runs", adminHandler(async () => runsOverview()));
  app.post("/api/admin/followups/:key/dismiss", adminHandler(async (req,_reply,admin) => dismissFollowUp(param(req,'key'),body<{reason:string}>(req).reason,actorOf(admin))));
  app.post("/api/admin/followups/:key/restore", adminHandler(async (req,reply,admin) => orNotFound(req,reply,await restoreFollowUp(param(req,'key'),body<{reason:string}>(req).reason,actorOf(admin)))));
  app.post("/api/admin/receipts/:id/release", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await releaseReceipt(Number(param(req, "id")), body(req) as never, actorOf(admin)))));
  app.post("/api/admin/processing/requeue", adminHandler(async (req, _reply, admin) => requeueFailedArticles(body(req) as never, actorOf(admin))));

  // Settings
  app.get("/api/admin/settings", adminHandler(async () => settingsOverview()));
  app.put("/api/admin/budgets/:service", adminHandler(async (req, _reply, admin) => updateBudget(param(req, "service"), body(req) as never, actorOf(admin))));


  // Models and evaluation (F20)
  app.get("/api/admin/models", adminHandler(async (req) => modelsOverview(Math.min(90, Number(q(req).days) || 7))));
  app.post("/api/admin/models/:capability", adminHandler(async (req, _reply, admin) => {
    const b = body<{ model: string | null; reason: string }>(req);
    return switchModel(param(req, "capability"), b.model ?? null, String(b.reason ?? ""), actorOf(admin));
  }));
  // SelectBench
  app.get("/api/admin/selectbench", adminHandler(async () => ({ runs: await listSelectBenchRuns() })));
  app.get("/api/admin/selectbench/:id", adminHandler(async (req, reply) => {
    const f = q(req);
    return orNotFound(req, reply, await selectBenchRun(param(req, "id"), { model: f.model, outcome: f.outcome, stratum: f.stratum, disagree: f.disagree === "1" }));
  }));
  app.post("/api/admin/selectbench/import", adminHandler(async (req, _reply, admin) => {
    const b = body<{ label: string; report: unknown }>(req);
    return importSelectBenchRun(b.report, String(b.label || "导入的对比运行"), actorOf(admin));
  }));

  app.get("/api/admin/nav-counts", adminHandler(async () => navCounts()));
  app.get("/api/admin/audit", adminHandler(async (req) => listAudit({ subject: q(req).subject, action: q(req).action, page: page(req) })));
}
