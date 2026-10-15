import type { RouteObject } from 'react-router';
import { AuthGate } from './components/AuthGate';
import { Layout } from './pages/Layout';
import { ListPage } from './pages/ListPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PlacePage } from './pages/PlacePage';
import { RadarPage } from './pages/RadarPage';

export const routes: RouteObject[] = [
  {
    // signed out: the login wall on every URL
    element: <AuthGate />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <ListPage /> },
          { path: 'place/:id', element: <PlacePage /> },
          { path: 'radar', element: <RadarPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
