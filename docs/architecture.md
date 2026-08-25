# FREE architecture

The maintained architecture model is
[`docs/architecture/current.c4`](./architecture/current.c4), with its viewing
and validation workflow in
[`docs/architecture/README.md`](./architecture/README.md).

The implemented request path is:

1. A humanities researcher reaches the private HTTPS origin through the host
   nginx reverse proxy.
2. Studio's Hono Node host serves the React UI, authenticates the session, and
   scopes every Project Store operation to the Researcher Account.
3. PostgreSQL stores durable Project Context, Source Document, Schema Revision,
   Extraction, Evidence, and Review Decision state.
4. The FastAPI Parsing Service accepts PDFs from Studio and produces a canonical
   ingestion package. Its task directory is a processor cache, not durable
   research state.
5. Studio retains packages in its operating-system data directory and executes
   configured local or remote Model Connections. The Parsing Service never runs
   extraction models.

`compose.yaml` is the deployable topology. There is no separate application
backend, durable parsing queue, credential vault, or key-management service in
the current system.
