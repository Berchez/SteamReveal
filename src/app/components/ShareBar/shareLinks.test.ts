import {
  buildPlayerSharePath,
  buildPlayerShareUrl,
  buildShareIntentLinks,
  copyTextToClipboard,
} from './shareLinks';

describe('shareLinks', () => {
  describe('buildPlayerSharePath', () => {
    it('builds the locale player path', () => {
      expect(buildPlayerSharePath('en', '76561198146333375')).toBe(
        '/en/player/76561198146333375',
      );
    });

    it('encodes special steamIds', () => {
      expect(buildPlayerSharePath('pt', 'a b/c')).toBe('/pt/player/a%20b%2Fc');
    });

    it('keeps every supported locale prefix intact', () => {
      expect(buildPlayerSharePath('ru', '123').startsWith('/ru/player/')).toBe(true);
    });
  });

  describe('buildPlayerShareUrl', () => {
    it('joins origin + path', () => {
      expect(
        buildPlayerShareUrl('https://steam-reveal.vercel.app', 'en', '123'),
      ).toBe('https://steam-reveal.vercel.app/en/player/123');
    });

    it('trims trailing slashes from the origin', () => {
      expect(
        buildPlayerShareUrl('https://example.com///', 'de', '123'),
      ).toBe('https://example.com/de/player/123');
    });
  });

  describe('buildShareIntentLinks', () => {
    it('encodes url and text into X/WhatsApp/Telegram intents', () => {
      const links = buildShareIntentLinks(
        'https://site/en/player/1',
        'See foo on SteamReveal',
      );
      expect(links.x).toContain('x.com/intent/post');
      expect(links.x).toContain(encodeURIComponent('https://site/en/player/1'));
      expect(links.whatsApp.startsWith('https://wa.me/')).toBe(true);
      expect(links.telegram.startsWith('https://t.me/share/url')).toBe(true);
    });

    it('never emits raw spaces', () => {
      const links = buildShareIntentLinks('https://site/a b', 'hi there');
      expect(`${links.x}${links.whatsApp}${links.telegram}`).not.toContain(' ');
    });
  });

  describe('copyTextToClipboard', () => {
    const originalNavigator = global.navigator;
    const docWithExec = document as Document & {
      execCommand: (command: string) => boolean;
    };
    const mutableDoc = docWithExec as unknown as {
      execCommand?: (command: string) => boolean;
    };
    const originalExecCommand = mutableDoc.execCommand;

    afterEach(() => {
      Object.defineProperty(global, 'navigator', {
        value: originalNavigator,
        configurable: true,
      });
      mutableDoc.execCommand = originalExecCommand;
      jest.restoreAllMocks();
    });

    it('uses navigator.clipboard when available', async () => {
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(global, 'navigator', {
        value: { clipboard: { writeText } },
        configurable: true,
      });
      await expect(copyTextToClipboard('abc')).resolves.toBe(true);
      expect(writeText).toHaveBeenCalledWith('abc');
    });

    it('falls back to execCommand when clipboard rejects', async () => {
      Object.defineProperty(global, 'navigator', {
        value: { clipboard: { writeText: jest.fn().mockRejectedValue(new Error('denied')) } },
        configurable: true,
      });
      const execCommand = jest.fn().mockReturnValue(true);
      mutableDoc.execCommand = execCommand;
      await expect(copyTextToClipboard('abc')).resolves.toBe(true);
      expect(execCommand).toHaveBeenCalledWith('copy');
    });

    it('returns false when nothing can copy', async () => {
      Object.defineProperty(global, 'navigator', {
        value: {},
        configurable: true,
      });
      mutableDoc.execCommand = jest.fn().mockImplementation(() => {
        throw new Error('nope');
      });
      await expect(copyTextToClipboard('abc')).resolves.toBe(false);
    });
  });
});
