import type { AhpTransport } from '@microsoft/agent-host-protocol/client';
import { createInMemoryTransportPair } from '@wyrd-company/ahp-server';

import { AhpClientRuntime, type AhpRuntimeOptions } from './ahp/runtime.js';

export interface ReusableAhpServer {
  accept(transport: AhpTransport): Promise<void>;
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
  const runtime = new AhpClientRuntime(clientTransport, options);

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
