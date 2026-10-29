// 业务错误携带 HTTP 状态；内部错误默认不向客户端公开文案。
export class AppError extends Error {
  readonly status: number;
  readonly statusCode: number;
  readonly code: string;
  readonly expose: boolean;

  constructor(message: string, status: number, code: string, expose = false) {
    super(message);
    this.status = status;
    this.statusCode = status;
    this.code = code;
    this.expose = expose;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) { super(message, 400, "invalid_request", true); }
}

export class NotFound extends AppError {
  constructor(message: string) { super(message, 404, "not_found", true); }
}

export class Conflict extends AppError {
  constructor(message: string) { super(message, 409, "conflict", true); }
}

export class Unavailable extends AppError {
  constructor(message: string) { super(message, 503, "temporarily_unavailable", true); }
}
