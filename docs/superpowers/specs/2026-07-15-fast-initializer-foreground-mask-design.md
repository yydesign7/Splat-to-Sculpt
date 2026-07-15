# Fast Initializer Foreground Mask Design

## Goal

Make foreground masks affect the complete Fast initializer reconstruction path, while preserving original RGB frames plus masks for True training.

## Data Flow

1. Copy selected source frames into `workDir/images` unchanged.
2. Generate one binary PNG mask per frame with rembg.
3. Generate same-named RGB working frames in `workDir/masked_images`, setting pixels outside each mask to black.
4. Run COLMAP feature extraction and mapping against original images so low-texture products can use the static environment for camera-pose estimation.
5. Run image undistortion, PatchMatch stereo, and depth estimation against `masked_images` using the camera model estimated from the original images.
6. Keep `workDir/images` as `colmapImagesDir` so True training receives original RGB frames; pass `workDir/masks` separately.
7. After stereo fusion, project every 3D point into a bounded set of registered cameras. Keep a point only when it lands inside the foreground mask in at least three views and at least 60 percent of its visible views.
8. Apply the same point filter to sparse fallback output and to optional depth-fusion output.

## Safety

- Mask generation remains non-fatal. If rembg or mask validation fails, all COLMAP stages use original frames.
- Multi-view filtering remains non-fatal. If camera metadata, masks, or filtering fail, reconstruction continues with the unfiltered PLY.
- A filtered result is accepted only when it contains at least 100 points and at least 1 percent of the input point count.
- File stems stay identical across original images, working images, masks, and COLMAP registrations.

## Testing

- Extend the foreground-mask regression test to verify black-background RGB output.
- Add a synthetic COLMAP text-model test that retains a center foreground point and rejects an off-mask point.
- Run Python syntax/tests, TypeScript checking, and lint.
