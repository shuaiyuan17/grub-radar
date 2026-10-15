import { createContext, use } from 'react';
import { CSRF_HEADER, ApiErrorSchema } from '../contracts/errors';
import {
  PhotoSchema,
  PlacePhotosResponseSchema,
  type Photo,
  type PlacePhotosResponse,
} from '../contracts/photos';
import { api, ApiRequestError } from './api';
import { preparePhoto, type PreparedPhoto } from './photoProcess';

/**
 * How the app talks to /api/photos*. Swapped for a fake in tests. Uploads go
 * through XMLHttpRequest, the one browser API that reports upload progress.
 */
export interface PhotosClient {
  forPlace(placeId: string): Promise<PlacePhotosResponse>;
  /** Shrinks and re-encodes `file` in the browser (see photoProcess). */
  prepare(file: File): Promise<PreparedPhoto>;
  upload(
    placeId: string,
    photo: PreparedPhoto,
    onProgress: (fraction: number) => void,
  ): Promise<Photo>;
  remove(id: string): Promise<void>;
  caption(id: string, caption: string): Promise<Photo>;
}

function xhrUpload(
  placeId: string,
  photo: PreparedPhoto,
  onProgress: (fraction: number) => void,
): Promise<Photo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/photos?place=${encodeURIComponent(placeId)}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', photo.type);
    xhr.setRequestHeader(CSRF_HEADER, '1');
    xhr.setRequestHeader('accept', 'application/json');
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => {
      reject(new ApiRequestError(0, 'network', 'network error'));
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // not JSON: handled below
      }
      if (xhr.status === 201) {
        const parsed = PhotoSchema.safeParse(body);
        if (parsed.success) {
          resolve(parsed.data);
          return;
        }
      }
      const err = ApiErrorSchema.safeParse(body);
      reject(
        err.success
          ? new ApiRequestError(xhr.status, err.data.error.code, err.data.error.message)
          : new ApiRequestError(xhr.status, 'http', `HTTP ${String(xhr.status)}`),
      );
    };
    xhr.send(photo.blob);
  });
}

export const httpPhotosClient: PhotosClient = {
  forPlace: async (placeId) =>
    PlacePhotosResponseSchema.parse(
      await (await api(`/api/photos?place=${encodeURIComponent(placeId)}`)).json(),
    ),
  prepare: preparePhoto,
  upload: xhrUpload,
  remove: async (id) => {
    await api(`/api/photos/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  caption: async (id, caption) =>
    PhotoSchema.parse(
      await (
        await api(`/api/photos/${encodeURIComponent(id)}`, { method: 'PATCH', body: { caption } })
      ).json(),
    ),
};

export const PhotosClientContext = createContext<PhotosClient>(httpPhotosClient);

export function usePhotosClient(): PhotosClient {
  return use(PhotosClientContext);
}
