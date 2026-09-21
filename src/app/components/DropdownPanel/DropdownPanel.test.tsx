import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import DropdownPanel from './DropdownPanel';

const renderPanel = (bodyClassName = '[scrollbar-width:thin]') =>
  render(
    <DropdownPanel
      ariaLabel="Notifications"
      maxHeightClass="max-h-[80vh]"
      scrollClassName={bodyClassName}
      header={<p>panel header</p>}
    >
      <p>panel body</p>
    </DropdownPanel>,
  );

describe('DropdownPanel', () => {
  it('renders the dialog shell with caret, static header, and body', () => {
    renderPanel();

    const dialog = screen.getByRole('dialog', { name: 'Notifications' });
    expect(dialog).toHaveClass('absolute', 'right-0', 'z-50', 'mt-2');
    expect(screen.getByTestId('dropdown-arrow')).toBeInTheDocument();

    const header = screen.getByText('panel header');
    const body = screen.getByText('panel body');
    expect(header).toBeInTheDocument();
    expect(body).toBeInTheDocument();

    // The max height lives on the outer shell (header + body share the
    // budget), clipped to the rounded border.
    const outer = dialog.querySelector('.rounded-2xl');
    expect(outer).not.toBeNull();
    expect(outer).toHaveClass(
      'max-h-[80vh]',
      'flex',
      'flex-col',
      'overflow-hidden',
      'border-gray-600',
      'bg-gray-900',
    );

    // The scroller owns the overflow; the header stays OUTSIDE it so it
    // never scrolls away.
    const scroller = dialog.querySelector('.overflow-y-auto');
    expect(scroller).not.toBeNull();
    expect(scroller).toContainElement(body);
    expect(scroller).not.toContainElement(header);
  });

  it('keeps vertical padding off the scroller (anti leak-back)', () => {
    renderPanel();

    // Scroll-contract: scroller padding is a FIXED scrollport zone that
    // scrolled items would paint over — vertical breathing room must come
    // from traveling content margins instead. Horizontal padding is safe
    // (nothing ever moves sideways).
    const scroller = screen
      .getByRole('dialog', { name: 'Notifications' })
      .querySelector('.overflow-y-auto');
    expect(scroller).not.toBeNull();
    expect(scroller).toHaveClass('px-4', 'min-h-0', '[scrollbar-width:thin]');
    expect(scroller).not.toHaveClass('p-4', 'py-4', 'pt-4', 'pb-4');
  });

  it('falls back to the inbox max height without extra scroll classes', () => {
    render(
      <DropdownPanel ariaLabel="Menu" header={<p>panel header</p>}>
        <p>panel body</p>
      </DropdownPanel>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Menu' });
    expect(dialog.querySelector('.rounded-2xl')).toHaveClass('max-h-96');
    expect(dialog.querySelector('.overflow-y-auto')).not.toHaveClass(
      '[scrollbar-width:thin]',
    );
  });
});
