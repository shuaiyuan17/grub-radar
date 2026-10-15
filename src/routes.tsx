import type { RouteObject } from 'react-router';
import { Layout } from './pages/Layout';
import { ListPage } from './pages/ListPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PlacePage } from './pages/PlacePage';
import { RadarPage } from './pages/RadarPage';

export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { index: true, element: <ListPage /> },
      { path: 'place/:id', element: <PlacePage /> },
      { path: 'radar', element: <RadarPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
