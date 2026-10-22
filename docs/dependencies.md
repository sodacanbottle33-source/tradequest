# Dependencies and licences

Check this list whenever a dependency is added. All current dependencies are free and open source; none are needed at runtime except React.

| Package | Used for | Runtime? | Licence |
|---------|----------|----------|---------|
| react, react-dom | User interface | Yes | MIT |
| vite | Dev server and build | No (dev only) | MIT |
| @vitejs/plugin-react | React support for Vite | No | MIT |
| vitest | Automated tests | No | MIT |
| typescript | Type checking | No | Apache-2.0 |
| @types/react, @types/react-dom, @types/node | Type definitions | No | MIT |

Notes:

- **No chart library.** The candlestick chart is a small hand-written SVG component (`src/ui/CandleChart.tsx`), so no TradingView attribution or extra licence is needed for Milestone 1.
- **No external fonts, APIs or data sources.** All prices are generated locally by the TradeQuest engine.
- `tools/reference_engine.py` uses only the Python standard library.
- Licences above are the packages' published licences as generally known; confirm in each package's `LICENSE` file under `node_modules/` before any commercial launch.
