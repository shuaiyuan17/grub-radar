import type { RouteObject } from 'react-router';
import { AuthGate } from './components/AuthGate';
import { Layout } from './pages/Layout';
import { ListPage } from './pages/ListPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PlacePage } from './pages/PlacePage';
import { RadarPage } from './pages/RadarPage';
import { AddSearchPage } from './pages/AddSearchPage';
import { AddSpotPage, EditSpotPage } from './pages/SpotFormPage';
import { FriendsPage } from './pages/FriendsPage';
import { FriendSpotsPage } from './pages/FriendSpotsPage';
import { InvitePage } from './pages/InvitePage';

export const routes: RouteObject[] = [
  {
    // signed out: the login wall on every URL
    element: <AuthGate />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <ListPage /> },
          // search Apple Maps first; by hand is the fallback
          { path: 'add', element: <AddSearchPage /> },
          { path: 'add/manual', element: <AddSpotPage /> },
          { path: 'place/:id', element: <PlacePage /> },
          { path: 'place/:id/edit', element: <EditSpotPage /> },
          { path: 'radar', element: <RadarPage /> },
          { path: 'friends', element: <FriendsPage /> },
          { path: 'friends/:id', element: <FriendSpotsPage /> },
          // the token is in the fragment (/invite#<token>), never the path
          { path: 'invite', element: <InvitePage /> },
          // owner-only: its own chunk; to anyone else it's the not-found page (see AdminPage)
          {
            path: 'admin',
            lazy: async () => ({ Component: (await import('./pages/admin/AdminPage')).AdminPage }),
          },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
