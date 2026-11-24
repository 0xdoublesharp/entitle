import "./marketing.css";
import { trackMarketingPageview } from "./marketing-analytics.ts";
import { mountPublicSite } from "./marketing.ts";
mountPublicSite();
void trackMarketingPageview();
