// The bar's and panel's CSS. The controls are Slack's own; this lays them
// out, on Slack's colour variables so it follows the theme.

export const panelCss = `
.huddlefm-bar.huddlefm-bar {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  padding: 0 4px 0 6px;
  box-sizing: border-box;
}
.huddlefm-bar__song {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 200px;
  height: 100%;
  padding-right: 4px;
  color: inherit;
  text-align: left;
}
.huddlefm-bar__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
}
.huddlefm-bar__title,
.huddlefm-bar__artist {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.huddlefm-bar__title {
  font-size: 13px;
  font-weight: 700;
}
.huddlefm-bar__artist {
  font-size: 12px;
  opacity: 0.75;
}
.huddlefm-bar .huddlefm-bar__control {
  color: inherit;
}
.huddlefm-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 360px;
  max-height: min(600px, 75vh);
  padding: 16px;
  box-sizing: border-box;
  overflow-y: auto;
  border-radius: 12px;
  background: var(--dt_color-base-pry, #fff);
  box-shadow: 0 0 0 1px var(--dt_color-otl-ter, #5e5d6021),
    0 4px 12px 0 rgba(0, 0, 0, 0.12);
  color: var(--dt_color-content-pry, #1d1c1d);
  font-size: 15px;
  line-height: 1.4;
}
.huddlefm-artwork {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  object-fit: cover;
}
.huddlefm-artwork--blank {
  background: var(--dt_color-otl-ter, #5e5d6021);
  color: var(--dt_color-content-ter, #5e5d60);
}
.huddlefm-added {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  vertical-align: bottom;
}
.huddlefm-start {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}
.huddlefm-start__user {
  align-self: stretch;
  text-align: left;
}
.huddlefm-start img {
  image-rendering: pixelated;
}
.huddlefm-start p {
  margin: 0;
}
.huddlefm-now__top {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.huddlefm-now__text {
  flex: 1;
  min-width: 0;
}
.huddlefm-now__title {
  font-weight: 900;
  font-size: 18px;
  line-height: 1.3;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.huddlefm-now__artist,
.huddlefm-now__meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dt_color-content-sec, #454447);
}
.huddlefm-now__meta {
  margin-top: 2px;
  font-size: 13px;
  color: var(--dt_color-content-ter, #5e5d60);
}
.huddlefm-host {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 12px;
  font-size: 13px;
  color: var(--dt_color-content-sec, #454447);
}
.huddlefm-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--dt_color-content-ter, #5e5d60);
}
.huddlefm-progress__time {
  min-width: 36px;
}
.huddlefm-progress__time:last-child {
  text-align: right;
}
.huddlefm-progress__slider,
.huddlefm-progress__live {
  flex: 1;
  min-width: 0;
}
.huddlefm-controls {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
}
.huddlefm-play.huddlefm-play {
  flex: none;
  margin: 0 4px;
}
.huddlefm-volume {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  margin-left: 12px;
  color: var(--dt_color-content-sec, #454447);
}
.huddlefm-volume__slider {
  flex: 1;
  min-width: 0;
}
.huddlefm-slider {
  appearance: none;
  height: 16px;
  margin: 0;
  background: none;
  cursor: pointer;
  --huddlefm-accent: rgba(var(--sk_highlight_accent, 29, 155, 209), 1);
  --huddlefm-track: linear-gradient(
    to right,
    var(--huddlefm-accent) var(--huddlefm-fill),
    rgba(var(--sk_foreground_low, 29, 28, 29), 0.13) var(--huddlefm-fill)
  );
}
.huddlefm-slider:focus {
  outline: none;
}
.huddlefm-slider::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 2px;
  background: var(--huddlefm-track);
}
.huddlefm-slider::-moz-range-track {
  height: 4px;
  border-radius: 2px;
  background: var(--huddlefm-track);
}
.huddlefm-slider::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  margin-top: -4px;
  border: none;
  border-radius: 50%;
  background: var(--huddlefm-accent);
  transform: scale(0);
  transition: transform 80ms cubic-bezier(0.36, 0.19, 0.29, 1);
}
.huddlefm-slider::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: none;
  border-radius: 50%;
  background: var(--huddlefm-accent);
  transform: scale(0);
  transition: transform 80ms cubic-bezier(0.36, 0.19, 0.29, 1);
}
.huddlefm-slider:hover::-webkit-slider-thumb,
.huddlefm-slider:active::-webkit-slider-thumb,
.huddlefm-slider:focus-visible::-webkit-slider-thumb {
  transform: scale(1);
}
.huddlefm-slider:hover::-moz-range-thumb,
.huddlefm-slider:active::-moz-range-thumb,
.huddlefm-slider:focus-visible::-moz-range-thumb {
  transform: scale(1);
}
.huddlefm-slider:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--huddlefm-accent) 30%, transparent);
}
/* Slack's form inputs leave room below for a hint this doesn't have */
.huddlefm-search .c-input_text {
  margin-bottom: 0;
}
.huddlefm-results {
  margin: 8px 0 0;
  padding: 4px 0;
  list-style: none;
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--dt_color-otl-ter, #5e5d6021);
  border-radius: 8px;
}
.huddlefm-result {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  font-size: 14px;
  text-align: left;
}
.huddlefm-result:hover,
.huddlefm-result:focus-visible {
  background: var(--dt_color-base-pry-hover, #4544470f);
}
.huddlefm-result__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.huddlefm-queue__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 28px;
  font-weight: 700;
  font-size: 13px;
  color: var(--dt_color-content-sec, #454447);
}
.huddlefm-queue__actions {
  display: flex;
}
.huddlefm-queue__list {
  margin: 4px -8px 0;
  padding: 0;
  list-style: none;
}
.huddlefm-track {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 8px;
  box-shadow: inset 0 2px 0 transparent;
}
.huddlefm-track:hover {
  background: var(--dt_color-base-pry-hover, #4544470f);
}
.huddlefm-track[draggable="true"] {
  cursor: grab;
}
/* where a dragged song would land, as a line between songs */
.huddlefm-track--gap-above {
  box-shadow: inset 0 2px 0 var(--dt_color-otl-hgl-1, #1264a3);
}
.huddlefm-track--gap-below {
  box-shadow: inset 0 -2px 0 var(--dt_color-otl-hgl-1, #1264a3);
}
.huddlefm-track--dragged {
  opacity: 0.4;
}
.huddlefm-track__text {
  flex: 1;
  min-width: 0;
}
.huddlefm-track__title,
.huddlefm-track__meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.huddlefm-track__title {
  font-size: 14px;
}
.huddlefm-track__meta,
.huddlefm-track__time {
  font-size: 12px;
  color: var(--dt_color-content-ter, #5e5d60);
}
.huddlefm-track__time {
  font-variant-numeric: tabular-nums;
}
.huddlefm-track__actions {
  display: flex;
  opacity: 0;
}
.huddlefm-track:hover .huddlefm-track__actions,
.huddlefm-track:focus-within .huddlefm-track__actions {
  opacity: 1;
}
.huddlefm-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.huddlefm-settings__header {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: -4px 0 -4px -8px;
  font-weight: 900;
  font-size: 18px;
}
.huddlefm-settings__tab {
  padding-top: 16px;
}
.huddlefm-settings__section {
  margin: 4px 0 8px;
  font-size: 15px;
  font-weight: 700;
}
.huddlefm-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
/* Slack's hint spaces the next field; a field without one does it here */
.huddlefm-field:not(:has(> .c-hint)) {
  margin-bottom: 20px;
}
.huddlefm-field > .c-hint {
  margin-top: 0;
}
.huddlefm-field__label {
  font-weight: 700;
  font-size: 14px;
}
.huddlefm-check {
  display: flex;
  align-items: center;
  gap: 8px;
}
.huddlefm-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 4px;
}
.huddlefm-settings__footer {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.huddlefm-now__start {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.huddlefm-end,
.huddlefm-load {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
/* the screen's own gap spaces its fields, so Slack's room under inputs and
   hints would double it */
.huddlefm-end .huddlefm-field,
.huddlefm-end .huddlefm-field > .c-hint,
.huddlefm-end .c-input_text,
.huddlefm-load .c-hint {
  margin-bottom: 0;
}
.huddlefm-load .huddlefm-settings__section {
  margin-top: 0;
}
.huddlefm-end__text {
  margin: 0;
  color: var(--dt_color-content-sec, #454447);
}
/* a control that's not allowed: it stays, to say why on hover */
.huddlefm-off {
  opacity: 0.4;
  cursor: not-allowed;
}
.huddlefm-slider-wrap {
  position: relative;
  display: flex;
  min-width: 0;
}
/* the time under the pointer, over a seek bar */
.huddlefm-slider__preview {
  position: absolute;
  bottom: calc(100% + 6px);
  transform: translateX(-50%);
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--dt_color-surf-inv-pry, #1d1c1d);
  color: var(--dt_color-content-inv-pry, #fff);
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}
.huddlefm-slider-wrap > .huddlefm-slider,
.huddlefm-slider-wrap > .huddlefm-off,
.huddlefm-slider-wrap > .huddlefm-off > .huddlefm-slider {
  flex: 1;
  width: 100%;
  min-width: 0;
}
.huddlefm-slider:disabled {
  cursor: not-allowed;
}
.huddlefm-sources {
  display: flex;
  gap: 4px;
  margin-top: 8px;
}
.huddlefm-source {
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 13px;
  color: var(--dt_color-content-sec, #454447);
  box-shadow: inset 0 0 0 1px var(--dt_color-otl-ter, #5e5d6021);
}
.huddlefm-source--on {
  color: var(--dt_color-content-inv-pry, #fff);
  background: var(--dt_color-surf-acc-pry, #1264a3);
  box-shadow: none;
}
.huddlefm-search__link {
  margin-top: 8px;
}
.huddlefm-results__heading {
  padding: 6px 12px 2px;
  font-size: 12px;
  font-weight: 700;
  color: var(--dt_color-content-ter, #5e5d60);
}
.huddlefm-suggestions {
  max-height: 300px;
}
.huddlefm-result__title,
.huddlefm-result__artist {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.huddlefm-result__artist {
  font-size: 12px;
  color: var(--dt_color-content-ter, #5e5d60);
}
.huddlefm-saves {
  margin: 0 -8px;
  padding: 0;
  list-style: none;
}
.huddlefm-save {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 6px 8px;
  border-radius: 8px;
  text-align: left;
}
.huddlefm-save:hover {
  background: var(--dt_color-base-pry-hover, #4544470f);
}
.huddlefm-save--on,
.huddlefm-save--on:hover {
  box-shadow: inset 0 0 0 2px var(--dt_color-otl-hgl-1, #1264a3);
}
.huddlefm-save__name {
  font-size: 14px;
  font-weight: 700;
}
.huddlefm-save__meta {
  font-size: 12px;
  color: var(--dt_color-content-ter, #5e5d60);
}
.huddlefm-lyrics {
  /* its lines' offsetTop counts from here, for scrolling to them */
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 280px;
  overflow-y: auto;
  padding: 12px 0;
  scrollbar-width: thin;
}
.huddlefm-lyric {
  margin: 0;
  padding: 2px 0;
  font-size: 17px;
  font-weight: 700;
  line-height: 1.35;
  text-align: left;
  color: var(--dt_color-content-ter, #5e5d60);
  opacity: 0.55;
  transition: opacity 200ms, color 200ms;
}
button.huddlefm-lyric:hover {
  opacity: 0.85;
}
.huddlefm-lyric--active {
  color: var(--dt_color-content-pry, #1d1c1d);
  opacity: 1;
}
.huddlefm-lyrics--plain .huddlefm-lyric {
  font-size: 15px;
  font-weight: 400;
  opacity: 1;
  color: var(--dt_color-content-pry, #1d1c1d);
}
.huddlefm-lyrics__none {
  margin: 12px 0 0;
  color: var(--dt_color-content-sec, #454447);
}
`;
