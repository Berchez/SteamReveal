import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useTranslations } from 'next-intl';
import UserCard from './UserCard';
import { getLocationDetails } from '@/app/templates/Home/useHome';
import { UserSummary } from 'steamapi';

jest.mock('next-intl', () => ({
  useTranslations: jest.fn(),
}));

jest.mock('../../templates/Home/useHome', () => ({
  getLocationDetails: jest.fn(),
}));

describe('UserCard Component', () => {
  const mockTranslator = (key: string) => {
    const translations: { [key: string]: string } = {
      nickname: 'Nickname',
      realName: 'Real Name',
      probability: 'Probability',
      url: 'Url',
      reliability: 'Reliability',
    };
    return translations[key];
  };

  const mockFriend: UserSummary = {
    steamID: '12345',
    avatar: {
      small: 'https://example.com/avatar-small.png',
      medium: 'https://example.com/avatar-medium.png',
      large: 'https://example.com/avatar-large.png',
      hash: 'https://example.com/avatar-hash.png',
    },
    nickname: 'User123',
    realName: 'John Doe',
    countryCode: 'us',
    stateCode: 'CA',
    cityID: '123',
    url: 'https://steamcommunity.com/id/user123',
    visible: true,
    personaState: 1,
    personaStateFlags: 0,
    lastLogOffAt: new Date(),
    createdAt: new Date(),
    primaryGroupID: '12345',
    allowsComments: true,
    profileURL: 'https://steamcommunity.com/id/user123',
  };

  beforeEach(() => {
    (useTranslations as jest.Mock).mockReturnValue(mockTranslator);
    (getLocationDetails as jest.Mock).mockResolvedValue({
      city: { name: 'San Francisco' },
      state: { name: 'California' },
      country: { name: 'United States' },
    });
  });

  it('renders the user avatar, nickname, and real name', async () => {
    await act(async () => {
      render(<UserCard friend={mockFriend} itsTargetUser={true} />);
    });

    expect(
      screen.getByAltText(/Avatar of the user User123/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nickname: User123/i)).toBeInTheDocument();
    expect(screen.getByText(/Real Name: John Doe/i)).toBeInTheDocument();
  });

  it('displays location details after fetching', async () => {
    await act(async () => {
      render(<UserCard friend={mockFriend} itsTargetUser={true} />);
    });

    expect(
      screen.getByAltText(/country flag \(us\) of the user User123/i),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByText(/San Francisco, California, United States/i),
      ).toBeInTheDocument();
    });
  });

  it('renders the probability, count, and URL if provided', async () => {
    await act(async () => {
      render(
        <UserCard
          friend={mockFriend}
          itsTargetUser={true}
          probability={85}
          count={10}
        />,
      );
    });

    expect(screen.getByText(/Probability: 85.00%/i)).toBeInTheDocument();
    expect(screen.getByText(/Reliability: 10/i)).toBeInTheDocument();
    expect(screen.getByText(/Url:/i)).toBeInTheDocument();
    expect(
      screen.getByRole('link', {
        name: /https:\/\/steamcommunity.com\/id\/user123/i,
      }),
    ).toBeInTheDocument();
  });
});
