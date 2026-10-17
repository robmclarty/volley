/**
 * An in-process ACP client for volley's agent: the SDK's own `client()`,
 * connected to an `acp_agent` app over newline-delimited JSON through a pair
 * of `TransformStream`s, the pattern fascicle's own ACP tests use. Messages
 * cross as real wire bytes rather than objects handed across by reference, so
 * a payload that doesn't survive JSON fails here as it would in an editor.
 */
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { ActiveSession, AgentApp, SessionUpdate, StopReason } from '@agentclientprotocol/sdk';

export type TurnRecord = {
  updates: SessionUpdate[];
  stop_reason: StopReason;
};

/** Connect a bare client to `app`, initialize, and start one session on
 * `cwd`, which has to exist, since `session/new` resolves it on disk. */
export async function open_session(app: AgentApp, cwd: string): Promise<ActiveSession> {
  const to_agent = new TransformStream<Uint8Array, Uint8Array>();
  const to_client = new TransformStream<Uint8Array, Uint8Array>();
  app.connect(ndJsonStream(to_client.writable, to_agent.readable));
  const { agent } = client().connect(ndJsonStream(to_agent.writable, to_client.readable));
  await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  return agent.buildSession({ cwd, mcpServers: [] }).start();
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
