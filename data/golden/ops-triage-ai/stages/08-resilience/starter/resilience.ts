export class ConcurrencyLimiter {
  // TODO: conte quantas execuções estão ativas.

  constructor(private readonly limit: number) {}

  tryAcquire(): boolean {
    // TODO: true e reserva uma vaga se houver; false se o limite foi atingido.
    return true;
  }

  release(): void {
    // TODO: libera uma vaga — nunca deixe o contador negativo.
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  // TODO: rejeite com new Error("request_timeout") se `promise` não terminar em timeoutMs.
  // Limpe o timer quando terminar (dica: Promise.race + finally).
  return promise;
}
