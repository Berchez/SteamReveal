import axios from 'axios';

/**
 * Extracts a readable message from an unknown error, handling Axios errors
 * explicitly instead of relying on a manual `as Error` cast.
 */
const getErrorMessage = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    return error.response
      ? `HTTP ${error.response.status}: ${error.message}`
      : error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

export default getErrorMessage;
