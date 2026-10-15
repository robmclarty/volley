import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A loopback fixture server: its origin, every request path it has seen, and a
 * way to stop it. */
export type TestServer = { origin: string; requests: string[]; close: () => Promise<void> };

const open_servers: TestServer[] = [];

/** Start an HTTP server on an ephemeral loopback port that records each
 * request's path, then hands the request to `handler`. Stop every server a test
 * started with `close_servers`, from an `afterEach`. */
export async function start_server(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<TestServer> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    handler(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const test_server: TestServer = {
    origin: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
  open_servers.push(test_server);
  return test_server;
}

export async function close_servers(): Promise<void> {
  await Promise.all(open_servers.splice(0).map((server) => server.close()));
}
