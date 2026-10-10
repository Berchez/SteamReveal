import React from 'react';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  ShareSquareIcon,
  XLogoIcon,
  WhatsAppLogoIcon,
  TelegramLogoIcon,
  LinkIcon,
  CheckIcon,
  ShareNodesIcon,
} from './ShareIcons';

const ICONS: Array<[string, () => React.JSX.Element]> = [
  ['share-square', () => <ShareSquareIcon className="h-4 w-4" />],
  ['x-logo', () => <XLogoIcon />],
  ['whatsapp-logo', () => <WhatsAppLogoIcon />],
  ['telegram-logo', () => <TelegramLogoIcon />],
  ['link', () => <LinkIcon />],
  ['check', () => <CheckIcon />],
  ['share-nodes', () => <ShareNodesIcon />],
];

describe('ShareIcons', () => {
  it.each(ICONS)('renders %s as a hidden svg', (_name, renderIcon) => {
    const { container } = render(renderIcon());
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('forwards className for sizing', () => {
    const { container } = render(<ShareSquareIcon className="h-4 w-4" />);
    expect(container.querySelector('svg')).toHaveClass('h-4 w-4');
  });
});
