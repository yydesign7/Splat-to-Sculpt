import type { ComponentPropsWithoutRef } from 'react';

type DynamicPreviewImageProps = Omit<ComponentPropsWithoutRef<'img'>, 'alt'> & {
  alt: string;
};

/** Renders Blob, ephemeral-session, and generated preview URLs without image proxying. */
export function DynamicPreviewImage({ alt, ...props }: DynamicPreviewImageProps) {
  // eslint-disable-next-line @next/next/no-img-element -- Dynamic preview sources must be loaded directly by the browser.
  return <img alt={alt} {...props} />;
}
