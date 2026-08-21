import React from "react";
import {Composition} from "remotion";
import {OGPOverview, OGPThumbnail} from "./video";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="OGPOverview" component={OGPOverview} durationInFrames={3600} fps={30} width={1920} height={1080} />
    <Composition id="OGPThumbnail" component={OGPThumbnail} durationInFrames={1} fps={30} width={1920} height={1080} />
  </>
);
