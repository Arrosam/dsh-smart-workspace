// Host-service lifecycle tests: which services the plugin requires, and how the optional
// ones (dsh-tools, dsh-user-approval) are picked up on a cordis-style host.
//
// The fake host below models three cordis 4.x rules the plugin depends on. The real
// framework is not importable in CI, so the rules are reproduced, not the framework:
//   1. every name in a plugin's `inject` is REQUIRED: apply runs only once all are present;
//   2. ctx.get(name) returns the service or undefined and never throws;
//   3. ctx.inject(names, cb) runs cb in a child context once all names exist, exposes them
//      as properties, and disposes the child's effects (reverse order) when one is removed;
//      the callback runs again with a fresh child when the service comes back.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, basename, sep } from 'node:path';
import * as plugin from '../lib/index.js';

const CHANNEL = '/workspace-mover';
const REQUIRED = ['workspaceRegistry', 'sessionPersistence'];
const AGENT_TOOLS = ['mover_list_sessions', 'mover_move_session', 'mover_begin_workspace', 'mover_repair_sessions', 'mover_doctor', 'mover_create_workspace', 'mover_rename_workspace'];
const TOOL = Object.freeze({ RENAME: 'mover_rename_workspace', MOVE: 'mover_move_session' });
const RM_TREE = { recursive: true, force: true, maxRetries: 3 };

const hosts = [];
afterEach(() => { for (const host of hosts.splice(0)) host.dispose(); });

/** A minimal fiber: effects registered while active, cleaned up in reverse order. */
function makeFiber() {
	const cleanups = [];
	return {
		effect(register) {
			const cleanup = register();
			if (typeof cleanup === 'function') cleanups.push(cleanup);
		},
		dispose() { while (cleanups.length) { try { cleanups.pop()(); } catch { /* best effort */ } } }
	};
}

/** Cordis-like host: required inject gate (rule 1), get (rule 2), nested inject (rule 3). */
function makeCordisHost(initial) {
	const services = new Map(Object.entries(initial));
	const watchers = []; // { names, callback, fiber? }
	const rootFiber = makeFiber();
	const eventListeners = new Map(); // event name -> [listener]

	const childCtx = (names, fiber) => {
		const ctx = {
			effect: fiber.effect,
			get: (key) => services.get(key),
			// cordis ctx.on: register on the event bus; the disposer is the calling fiber's effect.
			on(event, fn) {
				const list = eventListeners.get(event) ?? [];
				list.push(fn);
				eventListeners.set(event, list);
				fiber.effect(() => () => {
					const current = eventListeners.get(event) ?? [];
					const index = current.indexOf(fn);
					if (index >= 0) current.splice(index, 1);
				});
			}
		};
		for (const key of names) {
			const value = services.get(key);
			// A registration made through a child context is that child's effect (dsh-tools
			// `register` / systemPrompt `context` return a disposer tied to the calling fiber).
			ctx[key] = key === 'tools'
				? { ...value, register: (def) => { const off = value.register(def); fiber.effect(() => off); return off; } }
				: key === 'systemPrompt'
					? { ...value, context: (spec) => { const off = value.context(spec); fiber.effect(() => off); return off; } }
					: value;
		}
		return ctx;
	};

	const refresh = () => {
		for (const w of watchers) {
			const ready = w.names.every((n) => services.has(n));
			if (ready && !w.fiber) {
				w.fiber = makeFiber();
				w.callback(childCtx(w.names, w.fiber));
			} else if (!ready && w.fiber) {
				w.fiber.dispose();
				w.fiber = undefined;
			}
		}
	};

	const ctx = {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		get: (key) => services.get(key),
		effect: rootFiber.effect,
		inject(names, callback) { watchers.push({ names, callback }); refresh(); }
	};

	return {
		ctx,
		provide(name, value) { services.set(name, value); refresh(); },
		remove(name) { services.delete(name); refresh(); },
		listeners(event) { return [...(eventListeners.get(event) ?? [])]; },
		dispose() { for (const w of watchers) w.fiber?.dispose(); rootFiber.dispose(); }
	};
}

function makeEntity(id, path, title, log) {
	const record = { path, title, sessionIds: [] };
	return {
		id,
		get path() { return record.path; },
		get title() { return record.title; },
		get sessionIds() { return [...record.sessionIds]; },
		get record() { return record; },
		async setTitle(next) { log.push(next); record.title = next; },
		async status() { return 'ok'; },
		async attachSession() {},
		async detachSession() {}
	};
}

function makeTools() {
	const registered = new Map();
	return {
		registered,
		register(def) {
			assert.equal(registered.has(def.name), false, `${def.name} registered twice without being disposed`);
			registered.set(def.name, def);
			return () => registered.delete(def.name);
		}
	};
}

function makeApproval(outcome) {
	const calls = [];
	return { calls, outcome, async request(req) { calls.push(req); return this.outcome; } };
}

/**
 * Mount the plugin on a cordis-like host providing only the required services plus the
 * web transport. Applies the plugin only when its declared `inject` is satisfied (rule 1),
 * exactly as cordis would.
 */
function mountCordis() {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'wsm-hostsvc-')));
	const dirs = { home: join(root, 'home'), store: join(root, 'store'), a: join(root, 'alpha'), b: join(root, 'beta'), docs: join(root, 'docs') };
	for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
	const previousHome = process.env.DSH_HOME;
	process.env.DSH_HOME = dirs.home;

	const titles = [];
	const entities = [makeEntity('wid-a', dirs.a, basename(dirs.a), titles), makeEntity('wid-b', dirs.b, basename(dirs.b), titles)];
	const registry = {
		list: () => [...entities],
		get: (id) => entities.find((e) => e.id === id),
		archivedSessionIds: [],
		async create(path, title) {
			const entity = makeEntity(randomUUID(), path, title ?? basename(path), titles);
			entities.unshift(entity);
			return entity;
		},
		async delete(id) {
			const index = entities.findIndex((entity) => entity.id === id);
			if (index < 0) return false;
			entities.splice(index, 1);
			return true;
		}
	};
	let dispatch;
	const host = makeCordisHost({
		workspaceRegistry: registry,
		sessionPersistence: { root: dirs.store, compression: 'zstd', async list() { return []; } },
		connection: { rpc: { handle(channel, fn) { if (channel === CHANNEL) dispatch = fn; return () => {}; } } },
		webServer: {}
	});
	const ctx = { ...host.ctx, workspaceRegistry: registry, sessionPersistence: host.ctx.get('sessionPersistence') };

	const satisfied = plugin.inject.every((name) => host.ctx.get(name) !== undefined);
	if (satisfied) plugin.apply(ctx);

	const handle = {
		...host,
		satisfied,
		registry,
		titles,
		docs: dirs.docs,
		rpc: (endpoint, payload) => { assert.equal(typeof dispatch, 'function', 'RPC channel not mounted'); return dispatch(endpoint, payload ?? {}); },
		async doctorState(id) { return (await handle.rpc('mover.doctor')).value.checks.find((c) => c.id === id)?.state; },
		async agentTools() { return (await handle.rpc('mover.status')).value.agentTools; },
		dispose() {
			host.dispose();
			if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
			rmSync(root, RM_TREE);
		}
	};
	hosts.push(handle);
	return handle;
}

function makeExec(callId = 'call-1') {
	return { agent: { session: {} }, callId, signal: new AbortController().signal };
}

//#region 1. required services
test('inject names only the services the plugin cannot run without', () => {
	assert.deepEqual([...plugin.inject].sort(), [...REQUIRED].sort());
	assert.equal(plugin.inject.includes('tools'), false, 'tools must be optional: cordis deactivates the whole plugin when an injected service is missing');
	assert.equal(plugin.inject.includes('approval'), false, 'approval must be optional for the same reason');
});
//#endregion

//#region 2. no optional services
test('without dsh-tools and dsh-user-approval the plugin still mounts and the rescue RPC answers', async () => {
	const host = mountCordis();
	assert.equal(host.satisfied, true, 'required services alone satisfy inject');
	const status = await host.rpc('mover.status');
	assert.equal(status.ok, true, JSON.stringify(status.error));
	assert.equal(status.value.agentTools, false);
	assert.equal(await host.doctorState('host-approval'), 'warn');
	assert.equal(await host.doctorState('agent-tools'), 'warn');
});
//#endregion

//#region 3. tools follow the tools service (state transitions)
test('agent tools register with dsh-tools, unregister when it goes, and re-register once when it returns', async () => {
	const host = mountCordis();
	const tools = makeTools();

	assert.equal(await host.agentTools(), false, 'S0: no tools service');

	host.provide('tools', tools);
	assert.deepEqual([...tools.registered.keys()].sort(), [...AGENT_TOOLS].sort(), 'S1: all seven registered');
	assert.equal(await host.agentTools(), true);
	assert.equal(await host.doctorState('agent-tools'), 'pass');

	host.remove('tools');
	assert.equal(tools.registered.size, 0, 'S2: every registration disposed with the service');
	assert.equal(await host.agentTools(), false);
	assert.equal((await host.rpc('mover.status')).ok, true, 'plugin stays active without tools');

	host.provide('tools', tools); // register() asserts no duplicate
	assert.deepEqual([...tools.registered.keys()].sort(), [...AGENT_TOOLS].sort(), 'S3: registered again exactly once each');
	assert.equal(await host.agentTools(), true);
});
//#endregion

//#region 4. approval is read at call time
test('rename reads the approval service per call: absent → no prompt; added → asks; removed → no prompt again', async () => {
	const host = mountCordis();
	const tools = makeTools();
	host.provide('tools', tools);
	const rename = tools.registered.get(TOOL.RENAME);

	// No approval service: the product owner's rule is to proceed without a prompt.
	const first = await rename.execute({ workspaceId: 'wid-a', name: 'First' }, makeExec('call-1'));
	assert.equal(first.title, 'First');
	assert.equal(host.registry.get('wid-a').title, 'First');
	assert.equal(await host.doctorState('host-approval'), 'warn');

	// Approval appears later, without re-mounting the plugin.
	const approval = makeApproval('rejected');
	host.provide('approval', approval);
	assert.equal(await host.doctorState('host-approval'), 'pass');
	await assert.rejects(rename.execute({ workspaceId: 'wid-a', name: 'Second' }, makeExec('call-2')));
	assert.equal(approval.calls.length, 1, 'asked exactly once');
	assert.equal(host.registry.get('wid-a').title, 'First', 'rejected → unchanged');

	approval.outcome = 'allowed-once';
	const third = await rename.execute({ workspaceId: 'wid-a', name: 'Third' }, makeExec('call-3'));
	assert.equal(approval.calls.length, 2);
	assert.equal(third.title, 'Third');

	host.remove('approval');
	const fourth = await rename.execute({ workspaceId: 'wid-a', name: 'Fourth' }, makeExec('call-4'));
	assert.equal(approval.calls.length, 2, 'no prompt once the service is gone');
	assert.equal(fourth.title, 'Fourth');
	assert.deepEqual(host.titles, ['First', 'Third', 'Fourth'], 'setTitle only for the approved or unprompted renames');
});
//#endregion

//#region 5. callId is forwarded
for (const [toolName, args] of [
	[TOOL.RENAME, { workspaceId: 'wid-a', name: 'Renamed' }],
	[TOOL.MOVE, { sessionId: 'session-unknown', targetWorkspaceId: 'wid-b' }]
]) {
	test(`${toolName} approval request carries the tool call's callId (ACP answerer ignores requests without one)`, async () => {
		const host = mountCordis();
		const tools = makeTools();
		host.provide('tools', tools);
		const approval = makeApproval('rejected'); // rejected: nothing on disk is touched
		host.provide('approval', approval);
		const exec = makeExec(`call-${toolName}`);

		await assert.rejects(tools.registered.get(toolName).execute(args, exec));

		assert.equal(approval.calls.length, 1);
		const req = approval.calls[0];
		assert.equal(req.callId, exec.callId);
		assert.equal(req.agent, exec.agent);
		assert.equal(req.toolName, toolName);
		assert.equal(typeof req.reason, 'string');
		assert.equal(req.signal, exec.signal);
		assert.equal(host.registry.get('wid-a').title, basename(host.registry.get('wid-a').path), 'nothing renamed');
	});
}
//#endregion

//#region 6. system-prompt move notice
test('systemPrompt context tells the model when a move completed or is still queued', async () => {
  const host = mountCordis();
  const contexts = new Map();
  host.provide('systemPrompt', {
    context(spec) { contexts.set(spec.name, spec); return () => contexts.delete(spec.name); }
  });
  assert.ok(contexts.has('workspace-mover:last-move'), 'move notice registered with the prompt registry');
  const spec = contexts.get('workspace-mover:last-move');
  const session = { id: 'session-x' };
  assert.equal(spec.text({ agent: { session } }), '', 'no move data -> contributes nothing');

  const dataDir = join(process.env.DSH_HOME, 'workspace-mover');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'history.json'), JSON.stringify([{
    id: 'move-1', sessionId: 'session-x', title: 'X', sourceWorkspaceId: 'wid-a', targetWorkspaceId: 'wid-b',
    from: '/old/x', to: '/new/x', movedAt: '2026-01-02T03:04:05.000Z', backup: null
  }], null, 2));
  assert.match(spec.text({ agent: { session } }), /moved into workspace "\/new\/x".*completed.*do not retry/s);

  // A batch history entry is evidence for every session it moved.
  writeFileSync(join(dataDir, 'history.json'), JSON.stringify([{
    id: 'move-batch', sessionId: null, targetWorkspaceId: 'wid-b', to: '/new/batch',
    movedAt: '2026-01-02T04:00:00.000Z',
    sessions: [{ sessionId: 'session-y', title: 'Y', from: '/old/y', sourceWorkspaceId: 'wid-a', backup: null }]
  }], null, 2));
  assert.match(spec.text({ agent: { session: { id: 'session-y' } } }), /moved into workspace "\/new\/batch"/);

  // A pending queue record outranks the earlier completed move: report the truth, do not claim completion.
  writeFileSync(join(dataDir, 'migrations.json'), JSON.stringify({ version: 1, tasks: [{
    id: 'migration-1', sessionId: 'session-x', title: null, targetWorkspaceId: 'wid-b', sourceWorkspaceId: null,
    state: 'waiting-for-idle', attempts: 0, createdAt: '2026-01-02T05:00:00.000Z', updatedAt: '2026-01-02T05:00:00.000Z',
    lastError: 'session is currently running; waiting for idle', lastAttemptAt: null, completedAt: null
  }] }, null, 2));
  const pending = spec.text({ agent: { session } });
  assert.match(pending, /is queued/);
  assert.match(pending, /do not request it again/);
  assert.doesNotMatch(pending, /completed/);

  // Failed queue record: say it was NOT moved and point at the recovery path.
  const queue = JSON.parse(readFileSync(join(dataDir, 'migrations.json'), 'utf8'));
  queue.tasks[0].state = 'failed';
  queue.tasks[0].lastError = 'target not writable: EACCES';
  writeFileSync(join(dataDir, 'migrations.json'), JSON.stringify(queue, null, 2));
  const failed = spec.text({ agent: { session } });
  assert.match(failed, /FAILED: target not writable/);
  assert.match(failed, /was not moved/);

  // Diagnostics (no agent) and unrelated sessions contribute nothing.
  assert.equal(spec.text({}), '');
  assert.equal(spec.text({ agent: { session: { id: 'session-unknown' } } }), '');

  // Registration follows the service lifecycle.
  host.remove('systemPrompt');
  assert.equal(contexts.has('workspace-mover:last-move'), false, 'context disposed with the service');
});
//#endregion

//#region 7. non-cordis hosts
test('a host without inject still gets tools from ctx.tools and approval from ctx.approval', async () => {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'wsm-hostsvc-plain-')));
	const a = join(root, 'alpha');
	mkdirSync(a);
	const previousHome = process.env.DSH_HOME;
	process.env.DSH_HOME = join(root, 'home');
	const fiber = makeFiber();
	try {
		const titles = [];
		const entity = makeEntity('wid-a', a, 'alpha', titles);
		const tools = makeTools();
		const approval = makeApproval('allowed-once');
		const ctx = {
			workspaceRegistry: { list: () => [entity], get: (id) => (id === 'wid-a' ? entity : undefined), archivedSessionIds: [] },
			sessionPersistence: { root: join(root, 'store'), compression: 'zstd', async list() { return []; } },
			logger: { info() {}, warn() {} },
			get: () => undefined,
			effect: fiber.effect,
			connection: { rpc: { handle() { return () => {}; } } },
			tools,
			approval
		};
		plugin.apply(ctx);
		assert.deepEqual([...tools.registered.keys()].sort(), [...AGENT_TOOLS].sort());
		const value = await tools.registered.get(TOOL.RENAME).execute({ workspaceId: 'wid-a', name: 'Renamed' }, makeExec('call-plain'));
		assert.equal(approval.calls.length, 1);
		assert.equal(approval.calls[0].callId, 'call-plain');
		assert.equal(value.title, 'Renamed');
	} finally {
		fiber.dispose();
		if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
		rmSync(root, RM_TREE);
	}
});
//#endregion

//#region 8. no-workspace mode (v2.5)
test('no-workspace: the "No workspace" option is one shared read-only scratch workspace', async () => {
	const host = mountCordis();
	host.provide('workspaceController', { config: { documentsDirectory: host.docs } });
	const res = await host.rpc('mover.nows.prepare');
	assert.equal(res.ok, true, JSON.stringify(res.error));
	const { cwd, defaultWorkspaceRoot, tempRoot, readOnly, workspaceId, workspaceTitle } = res.value;
	assert.equal(readOnly, true);
	assert.equal(workspaceTitle, 'No workspace');
	assert.equal(workspaceId, host.registry.list().find((entity) => entity.path === cwd)?.id, 'a real workspace is registered over the folder');
	assert.equal(host.registry.get(workspaceId).title, 'No workspace');
	assert.equal(defaultWorkspaceRoot, realpathSync(join(host.docs, 'deepseek-harness', 'default-workspace')));
	assert.equal(tempRoot, join(defaultWorkspaceRoot, '.workspace-mover-tmp'));
	assert.ok(cwd.startsWith(tempRoot + sep));
	assert.equal(cwd, join(tempRoot, 'scratch'), 'every no-workspace session shares this folder');
	const stats = statSync(cwd);
	assert.equal(stats.isDirectory(), true);
	assert.equal(stats.mode & 0o200, 0, 'scratch folder must be read-only on disk');

	// idempotent: the selector option is created once, never one group per session
	const again = await host.rpc('mover.nows.prepare');
	assert.equal(again.value.workspaceId, workspaceId);
	assert.equal(host.registry.list().filter((entity) => entity.path.startsWith(tempRoot)).length, 1);

	const status = await host.rpc('mover.status');
	assert.equal(status.value.capabilities.noWorkspace, true);
	assert.equal(status.value.capabilities.noWorkspaceRoot, defaultWorkspaceRoot);
	assert.equal(status.value.capabilities.noWorkspaceWorkspaceId, workspaceId);

	const doctor = await host.rpc('mover.doctor');
	const check = doctor.value.checks.find((item) => item.id === 'no-workspace');
	assert.ok(check, 'doctor reports a no-workspace check');
	assert.equal(check.state, 'pass', check.detail);
	assert.match(check.detail, /read-only/);
});

test('no-workspace: systemPrompt notice and write guard steer the model to mover_begin_workspace', async () => {
	const host = mountCordis();
	host.provide('workspaceController', { config: { documentsDirectory: host.docs } });
	const contexts = new Map();
	host.provide('systemPrompt', {
		context(spec) { contexts.set(spec.name, spec); return () => contexts.delete(spec.name); }
	});
	host.provide('tools', makeTools());
	await host.rpc('mover.nows.prepare');

	const promptSpec = contexts.get('workspace-mover:no-workspace');
	assert.ok(promptSpec, 'no-workspace prompt registered with the prompt registry');
	const prepared = await host.rpc('mover.nows.prepare');
	const tempCwd = prepared.value.cwd;
	const text = promptSpec.text({ agent: { session: { id: 's-nows', header: { cwd: tempCwd } } } });
	assert.match(text, /NO-WORKSPACE mode/);
	assert.match(text, /mover_begin_workspace/);
	assert.match(text, /read-only/);
	assert.equal(promptSpec.text({ agent: { session: { id: 's-normal', header: { cwd: host.docs } } } }), '', 'a normal session gets no notice');
	assert.equal(promptSpec.text({}), '');

	const listeners = host.listeners('tools/pre-execute');
	assert.equal(listeners.length, 1, 'the write guard subscribed once');
	const execFor = (toolName, cwd) => ({ name: toolName, agent: { session: { header: { cwd } } } });
	let nextCalls = 0;
	const next = () => { nextCalls += 1; return Promise.resolve({ kind: 'allow' }); };
	for (const toolName of ['write', 'edit', 'str_replace_editor', 'bash', 'terminal_send']) {
		const decision = await listeners[0](execFor(toolName, tempCwd), next);
		assert.equal(decision.kind, 'deny', `${toolName} must be denied in no-workspace mode`);
		assert.match(decision.reason, /mover_begin_workspace/);
	}
	assert.equal(nextCalls, 0, 'denied calls never reach the next gate');
	const read = await listeners[0](execFor('read', tempCwd), next);
	assert.equal(read.kind, 'allow');
	const outside = await listeners[0](execFor('write', host.docs), next);
	assert.equal(outside.kind, 'allow');
	assert.equal(nextCalls, 2);
});
//#endregion
