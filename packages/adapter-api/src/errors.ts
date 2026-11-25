/** A non-2xx answer, an `error` event inside a stream, or a stalled stream. Messages never contain keys. */
export class ApiError extends Error {
  readonly status: number | undefined;
  readonly type: string | undefined;
  constructor(message: string, status?: number, type?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
  }
}
