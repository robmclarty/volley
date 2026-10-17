/**
 * An in-process ACP client for volley's agent: the SDK's own `client()`,
 * connected to an `acp_agent` app over newline-delimited JSON through a pair
 * of `TransformStream`s, the pattern fascicle's own ACP tests use. Messages
 * cross as real wire bytes rather than objects handed across by reference, so
 * a payload that doesn't survive JSON fails here as it would in an editor.
 */
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  ActiveSession,
  AgentApp,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionModeId,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk';

export type TurnRecord = {
  updates: SessionUpdate[];
  stop_reason: StopReason;
};

export type SessionOptions = {
  /** Answers each permission request the agent sends. Without it, a request
   * fails, and the agent takes that as a refusal. */
  on_permission?: (
    request: RequestPermissionRequest,
  ) => RequestPermissionResponse | Promise<RequestPermissionResponse>;
  /** The mode the session switches to once it opens, as a user would pick it. */
  mode?: SessionModeId;
};

/** Connect a client to `app`, initialize, and start one session on `cwd`,
 * which has to exist, since `session/new` resolves it on disk. */
export async function open_session(
  app: AgentApp,
  cwd: string,
  options: SessionOptions = {},
): Promise<ActiveSession> {
  const to_agent = new TransformStream<Uint8Array, Uint8Array>();
  const to_client = new TransformStream<Uint8Array, Uint8Array>();
  app.connect(ndJsonStream(to_client.writable, to_agent.readable));
  const app_client = client();
  const { on_permission } = options;
  if (on_permission !== undefined) {
    app_client.onRequest('session/request_permission', ({ params }) => on_permission(params));
  }
  const { agent } = app_client.connect(ndJsonStream(to_agent.writable, to_client.readable));
  await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const session = await agent.buildSession({ cwd, mcpServers: [] }).start();
  if (options.mode !== undefined) {
    await agent.request('session/set_mode', { sessionId: session.sessionId, modeId: options.mode });
  }
  return session;
}

/** Read a session's updates, in the order they arrived, until its turn stops. */
export async function read_turn(session: ActiveSession): Promise<TurnRecord> {
  const updates: SessionUpdate[] = [];
  for (;;) {
    const message = await session.nextUpdate();
    if (message.kind === 'stop') return { updates, stop_reason: message.stopReason };
    updates.push(message.update);
  }
}
