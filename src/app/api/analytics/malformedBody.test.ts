/**
 * @jest-environment node
 */

import { malformedBodyResponse } from './malformedBody';

describe('malformedBodyResponse (benign-noise contract)', () => {
  it('warns with the route name and returns 400 INVALID_REQUEST', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = malformedBodyResponse(
        'recordAnalytics/cheater',
        new SyntaxError("Unexpected token '\\'"),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('recordAnalytics/cheater - malformed JSON body'),
      );
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('never throws on non-Error values', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const value of [undefined, null, 42, 'bad']) {
        expect(() =>
          malformedBodyResponse('recordAnalytics', value),
        ).not.toThrow();
      }
    } finally {
      warnSpy.mockRestore();
    }
  });
});
