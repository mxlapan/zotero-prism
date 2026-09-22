/* eslint-disable */
// ---------------------------------------------------------------- global
pref("enableSpectrum", true);
pref("enableLens", true);
pref("enableRefract", true);
pref("enableBeam", true);

// ---------------------------------------------------------------- spectrum (library visuals)
pref("spectrum.heatmap", true);
pref("spectrum.heatmapColor", "#2ea8e5");
pref("spectrum.boldUnread", true);
pref("spectrum.progressColumn", true);
pref("spectrum.tagsColumn", true);
pref("spectrum.hashTagColumn", true);
pref("spectrum.hashTagPrefix", "#");
pref("spectrum.hashTagMap", "");
pref("spectrum.rankColumn", true);
pref("spectrum.rankFields", "sciUp,sciif,ccf,pku,cssci");
pref("spectrum.rankMap", "SCIWARN=🚫, /SCIIF/=IF, ");
pref("spectrum.easyScholarKey", "");
pref("spectrum.citedColumn", true);
pref("spectrum.citedSource", "semanticscholar");
pref("spectrum.citedMap", "Total(S2)=, Highly Influential=HI, Background=B, Methods=M, Results=R");
pref("spectrum.ratingColumn", true);
pref("spectrum.viewGroups", "[]");
pref("spectrum.annotationColors", "{}");
pref("spectrum.tabGroups", "[]");
pref("spectrum.matrixFields", "[]");

// ---------------------------------------------------------------- lens (AI)
pref("lens.provider", "openai");
pref("lens.baseURL", "https://api.openai.com");
pref("lens.fullURL", false);
pref("lens.apiKey", "");
pref("lens.model", "gpt-4o-mini");
pref("lens.temperature", "0.5");
pref("lens.maxTokens", 4096);
pref("lens.stream", true);
pref("lens.profiles", "[]");
pref("lens.systemPrompt", "You are a rigorous research assistant working inside Zotero. Answer with precision, cite page numbers when the context provides them, and say plainly when the provided context does not contain the answer.");
pref("lens.embedBaseURL", "https://api.openai.com/v1/embeddings");
pref("lens.embedApiKey", "");
pref("lens.embedModel", "text-embedding-3-small");
pref("lens.chunkSize", 1200);
pref("lens.chunkOverlap", 160);
pref("lens.topK", 8);
pref("lens.bridgeEnabled", false);
pref("lens.bridgeTarget", "");
pref("lens.prompts", "[]");
pref("lens.panelWidth", 420);
pref("lens.panelFontSize", 14);
pref("lens.readerBindMode", "page");
pref("lens.annotationWriteBack", false);
pref("lens.provenance", true);

// ---------------------------------------------------------------- refract (translation)
pref("refract.engine", "google");
pref("refract.targetLang", "zh-CN");
pref("refract.sourceLang", "auto");
pref("refract.alignment", "paragraph");
pref("refract.engineFallback", true);
pref("refract.keepFormulas", true);
pref("refract.bodyOnly", true);
pref("refract.skipReferences", true);
pref("refract.skipCaptions", false);
pref("refract.fontSize", 15);
pref("refract.lineHeight", "1.5");
pref("refract.fontFamily", "");
pref("refract.concurrency", 4);
pref("refract.engineKeys", "{}");
pref("refract.hoverOriginal", true);
pref("refract.selectionPopup", true);
pref("refract.autoTranslateTitle", false);
pref("refract.layoutService", "");
pref("refract.layoutServiceType", "pdf2zh");
pref("refract.layoutServiceKey", "");
pref("refract.cacheEnabled", true);

// ---------------------------------------------------------------- beam (new features)
pref("beam.rhythmGoalMinutes", 45);
pref("beam.review", true);
pref("beam.reviewDaily", 12);
pref("beam.reviewIntervals", "1,3,7,16,35,90");
pref("beam.gapMinHits", 3);
pref("beam.watchlist", "[]");
pref("beam.watchIntervalHours", 24);
pref("beam.lastWatchRun", 0);
