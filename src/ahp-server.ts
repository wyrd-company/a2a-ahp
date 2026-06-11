import type { JsonRpcMessage, TransportFrame } from '@microsoft/agent-host-protocol/client';
import type { AhpTransport } from '@microsoft/agent-host-protocol/client';
import { createInMemoryTransportPair, type ServerTransport } from '@wyrd-company/ahp-server';

import { AhpClientRuntime, type AhpRuntimeOptions } from './ahp/runtime.js';

export interface ReusableAhpServer {
  accept(transport: ServerTransport): Promise<void>;
}

export interface InProcessAhpRuntimeOptions extends AhpRuntimeOptions {
  readonly server: ReusableAhpServer;
}

export interface InProcessAhpRuntime {
  readonly runtime: AhpClientRuntime;
  readonly serverRun: Promise<void>;
  close(): Promise<void>;
}

export function createInProcessAhpRuntime(options: InProcessAhpRuntimeOptions): InProcessAhpRuntime {
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const serverRun = options.server.accept(serverTransport);
  const runtime = new AhpClientRuntime(asAhpTransport(clientTransport), options);

  return {
    runtime,
    serverRun,
    async close(): Promise<void> {
      await runtime.shutdown();
      await clientTransport.close();
      await Promise.allSettled([serverRun]);
    },
  };
}

function asAhpTransport(transport: ServerTransport): AhpTransport {
  return {
    send(message: JsonRpcMessage | string): Promise<void> | void {
      return transport.send(message as never);
    },
    async recv(): Promise<TransportFrame | null> {
      const message = await transport.recv();
      if (message === null) return null;
      if (typeof message === 'string') return { kind: 'text', text: message };
      return { kind: 'parsed', message: message as never };
    },
    close(): Promise<void> | void {
      return transport.close();
    },
  };
}
