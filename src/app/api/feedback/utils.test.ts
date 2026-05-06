// Mock Resend before importing sendFeedbackEmail
const mockSend = jest.fn();
jest.mock('resend', () => {
  return {
    Resend: jest.fn().mockImplementation(() => ({
      emails: {
        send: (args: any) => mockSend(args),
      },
    })),
  };
});

// Import after mock
import sendFeedbackEmail from './utils';

describe('sendFeedbackEmail', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({ id: '123' });
    process.env = { ...originalEnv };
    process.env.FEEDBACK_RESEND_EMAIL = 'test@example.com';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('throws error if FEEDBACK_RESEND_EMAIL is missing', async () => {
    delete process.env.FEEDBACK_RESEND_EMAIL;
    await expect(
      sendFeedbackEmail({
        message: 'test',
        type: 'bug',
        page: '/',
        language: 'en',
        userAgent: 'test-agent',
      }),
    ).rejects.toThrow('Missing FEEDBACK_RESEND_EMAIL env var');
  });

  it('calls resend.emails.send with correct parameters and escapes HTML', async () => {
    const data = {
      message: 'Hello <script>alert("xss")</script>',
      type: 'bug',
      page: '/home?a=1&b=2',
      language: 'pt',
      userAgent: 'Mozilla/5.0',
    };

    await sendFeedbackEmail(data);

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'SteamReveal <onboarding@resend.dev>',
        to: 'test@example.com',
        subject: '[Feedback][bug] SteamReveal',
        html: expect.stringContaining('&lt;script&gt;'),
      }),
    );

    // Check if ampersand is escaped in page URL if it was used in HTML
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining('/home?a=1&amp;b=2'),
      }),
    );
  });

  it('throws error if resend fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('Resend failed'));

    await expect(
      sendFeedbackEmail({
        message: 'test',
        type: 'bug',
        page: '/',
        language: 'en',
        userAgent: 'test-agent',
      }),
    ).rejects.toThrow('Resend failed');
  });
});
