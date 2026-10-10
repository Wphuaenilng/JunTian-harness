export { MarkdownBlock, DiffBlock, ToolOutputBlock, looksLikePatch, renderMarkdown, parseUnifiedDiff, diffStats } from './components.tsx'
export { highlightCodeBlocks, decodeEntities, languageOf, resetHighlightCache, highlightStats, type FenceRenderer } from './highlight.ts'
export { AppFrame, type AppFrameProps } from './app-frame-view.tsx'
export {
  APP_NAMESPACE,
  OPAQUE_ORIGIN,
  MIN_HEIGHT,
  MAX_HEIGHT,
  bridgeBootstrap,
  clampHeight,
  createNonce,
  decodeInbound,
  encodeOutbound,
  injectBridge,
  looksLikeHtmlDocument,
  type AppInbound,
  type AppOutbound,
} from './app-frame.ts'
