import axios from 'axios';

export default function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    return error.response
      ? `HTTP ${error.response.status}: ${error.message}`
      : error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}
