# Application Composition and Use-Case Pipelines

**Status**: Accepted

The backend uses a TypeScript serverless function architecture under `prototypes/studio/api/` for application composition, dependency routing, and use-case execution. The FastAPI backend (`prototypes/parsing_service`) acts exclusively as a document parsing and OCR indexing microservice.

## Decided Design

- **Vercel Serverless Routing**: Routing is handled via Vercel serverless function routes (`/api/*` inside `prototypes/studio/api/`). Each route acts as a lightweight HTTP adapter.
- **Direct Modular Imports**: Instead of utilizing a centralized dependency injection container or application lifespan facade, route handlers directly import modular functions (e.g. `extractWithModel` in [_model.ts](file:///c:/Users/arkan/.codex/worktrees/9bfd/FREE/prototypes/studio/api/_model.ts)).
- **Result Objects & Mapping**: Model execution helper functions return plain TypeScript result objects, which are mapped to HTTP responses in route files using the `json()` utility from [_http.ts](file:///c:/Users/arkan/.codex/worktrees/9bfd/FREE/prototypes/studio/api/_http.ts).
- **Error Mapping**: Operational errors are caught using a custom `RequestError` containing HTTP status and details, which are converted to HTTP error responses via the `modelError(error)` utility.
- **Document Indexing Separation**: Document ingestion, layout analysis, and text extraction (using Docling and PaddleOCR) are delegated asynchronously to `prototypes/parsing_service`. The resulting parsed Markdown represents the document's content, which is retrieved and cached by the frontend.


