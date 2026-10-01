export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export function notFound(resource: string): AppError {
  return new AppError(404, `${resource}_not_found`, `${resource === "order" ? "订单" : "资源"}不存在`);
}

