import { brave } from "./brave";
import { deepseek } from "./deepseek";
import type { WebSearchBackend } from "./settings";
import { tavily } from "./tavily";
import type { SearchService } from "./types";

export const SEARCH_SERVICES: Record<WebSearchBackend, SearchService> = {
    brave,
    tavily,
    deepseek,
};
