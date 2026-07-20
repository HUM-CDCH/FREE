# FREE architecture

The sequence below describes the wider researcher workflow. For the implemented
source-document ingestion boundary, see
[Canonical source document parsing](parsing-service.md). Its table, OCR,
geometry, and evaluation rules are recorded in
[Parsing quality policy](parsing-quality.md).

```mermaid
sequenceDiagram
    participant U as User
    participant FE as React Frontend
    participant API as FastAPI Backend
    participant A as Annotation Store
    participant SG as Schema Suggestion Service
    participant S as Single Extraction Service
    participant P as Extraction Pipeline
    participant C as Core Extraction
    participant L as LLM Client
    participant M as OpenAI/Gemini/Ollama
    participant FS as File Store

    Note over U,FS: Phase 1 - Document Ingestion

    U->>FE: Upload or open source document
    FE->>API: POST /documents/prepare
    API->>S: Prepare document
    S->>FS: Save source PDF and check cache

    alt Native-digital PDF with text layer
        S->>S: Deterministic text extraction without LLM
    else Scanned PDF or complex layout
        S->>L: Layout parsing pass with Docling and optional LLM
        L->>M: Provider API call
        M-->>L: Structured page content
        L-->>S: Layout-parsed document
    end

    S-->>API: Document hash and metadata
    API-->>FE: Prepared document metadata
    FE-->>U: Show document in viewer, ready to annotate

    Note over U,FS: Phase 2 - Context Gathering, all inputs are optional

    opt User highlights text spans
        U->>FE: Highlight text span and optionally add label or note
        FE->>API: POST /annotations
        API->>A: Save annotation with hash, span, page, quote, and label
        A-->>API: Annotation ID
        API-->>FE: Annotation saved
        FE-->>U: Show highlight in document viewer
    end

    opt User provides a natural language prompt
        U->>FE: Type extraction prompt
        FE->>API: POST /extraction-prompts
        API->>A: Save prompt with document hash
        API-->>FE: Prompt saved
    end

    Note over U,FS: Phase 3 - Schema Derivation, always runs before extraction

    U->>FE: Initiate extraction
    FE->>API: POST /schema-suggestions
    API->>A: Load annotations and prompt if available
    API->>SG: Derive schema from available context

    alt Annotations and/or prompt provided
        SG->>L: Infer schema from annotations and prompt
    else No context provided
        SG->>L: Detect document domain and propose default schema
    end

    L->>M: Provider API call
    M-->>L: JSON response
    L-->>SG: Suggested fields, types, and example values
    SG-->>API: Suggested schema
    API-->>FE: Schema suggestions
    FE-->>U: Show proposed schema

    opt User reviews schema
        U->>FE: Approve, edit, or reject schema fields
        FE->>API: POST /schema-suggestions/:id/review
        API->>FS: Save reviewed schema
        API-->>FE: Reviewed schema confirmed
    end

    Note over U,FS: Phase 4 - Extraction

    FE->>API: POST /extractions
    API->>FS: Load confirmed or auto-approved schema
    API->>S: Run extraction with document hash, schema, and model
    S->>S: Optionally extract tables
    S->>P: Run extraction with parsed text, schema, and model
    P->>C: Choose standard, doctags, or hierarchical extractor
    C->>L: Send messages as JSON chat request
    L->>M: Provider API call
    M-->>L: JSON response
    L-->>C: Parsed JSON
    C-->>P: Schema-conformant record with evidence
    P-->>S: Results and prompt audit
    S->>FS: Save extraction JSON and prompt JSON
    S-->>API: Extraction results
    API-->>FE: Extraction results
    FE-->>U: Show extracted records with source-linked evidence highlights

    Note over U,FS: Phase 5 - Validation, optional

    opt User validates results
        U->>FE: Confirm, edit, or reject extracted values
        FE->>API: POST /validations
        API->>FS: Append validation decision to annotation JSONL
        API-->>FE: Validation saved
        FE-->>U: Show reviewed status and flag remaining unvalidated fields
    end
```
