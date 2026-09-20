# LLM Gateway + Semantic Cache — Build & Learning Plan

## Mission

Build an LLM Gateway that demonstrates serious backend and infrastructure engineering rather than a thin LLM wrapper.

The final system should be able to:

- expose an OpenAI-compatible API
- normalize and validate LLM requests
- perform exact caching
- perform semantic caching
- make safe cache-reuse decisions
- support streaming responses
- route requests to providers/models
- handle timeouts, retries, rate limits, and concurrency
- isolate tenants
- track latency, tokens, cost, cache hits, and savings
- evaluate semantic-cache correctness with a repeatable benchmark
- degrade gracefully when infrastructure such as Redis/vector storage is unavailable
- provide enough architecture and observability to explain every important design decision in an interview

The project should be built as a sequence of verified engineering increments. Do not jump directly into semantic caching.

---

# 1. The Operating Mental Model

The system is not "an API that calls an LLM."

It is a decision pipeline:

```text
Client
  |
  v
[API / Protocol]
  |
  v
[Normalize Request]
  |
  v
[Validate + Tenant Context]
  |
  v
[Exact Cache Lookup]
  |
  +---- HIT ------------------------------+
  |                                       |
  v                                       |
[Semantic Cache Lookup]                   |
  |                                       |
  +---- HIT ------------------------------+
  |                                       |
  v                                       |
[Policy / Reuse Decision]                 |
  |                                       |
  +---- SAFE -----------------------------+
  |                                       |
  v                                       |
[Model Router]                            |
  |                                       |
  v                                       |
[LLM Provider]                            |
  |                                       |
  v                                       |
[Response Processor]                      |
  |                                       |
  v                                       |
[Cache Admission]                         |
  |                                       |
  v                                       |
[Observability] --------------------------+
  |
  v
Client
```

Every stage should answer one question:

```text
Protocol       -> What did the client ask?
Normalization  -> What is the canonical representation?
Exact cache   -> Have I seen this exact request?
Semantic cache -> Have I seen an equivalent request?
Policy         -> Is reuse safe?
Router         -> Where should execution happen?
Provider       -> What generated the answer?
Admission      -> Should this result enter the cache?
Observability  -> What happened and what did it cost?
```

The central distinction is:

```text
Similarity != Equivalence != Reusability
```

Two requests can be semantically similar without being safe to reuse.

---

# 2. How You Learn While You Build

Use a 60/40 rule:

```text
60% implementation + experiments
40% focused learning
```

Do not spend a week reading about Redis, then another week reading about vector databases, and only afterward start coding.

Instead:

```text
Learn one concept
    ->
Write a tiny experiment
    ->
Implement it in the gateway
    ->
Test failure cases
    ->
Document the decision
    ->
Move forward
```

For every concept, produce four things:

1. **Mental model**
2. **Tiny experiment**
3. **Production implementation**
4. **Failure/edge-case test**

Example:

```text
Redis TTL
  ->
learn expiration semantics
  ->
make 20-line TTL experiment
  ->
implement cache TTL
  ->
test expired/missing/concurrent entries
```

This prevents passive learning and makes the knowledge stick.

---

# 3. How to Use AI Without Losing Understanding

AI is allowed to accelerate implementation, but it must never become the source of architectural understanding.

Use this workflow for every feature:

```text
YOU define the requirement
        |
        v
AI reviews ambiguity
        |
        v
YOU write/approve architecture
        |
        v
AI proposes implementation
        |
        v
YOU inspect the design
        |
        v
AI implements a small increment
        |
        v
Tests + validation
        |
        v
AI explains failures
        |
        v
YOU verify behavior
```

Never give the AI:

> "Build the semantic cache."

Instead give it a bounded task:

> "Implement the cache repository described in architecture.md. Do not change the public interface. First inspect the existing code and list assumptions. Then implement only the repository and tests."

Before each AI coding session, provide:

```text
architecture.md
product.md
loop.md
current implementation
relevant tests
current task
constraints
```

The AI must not silently change architecture.

---

# 4. The AI Development Loop

Keep a `loop.md` in the repository.

The loop should enforce:

```text
1. Read product.md
2. Read architecture.md
3. Read current implementation
4. Identify the exact task
5. Identify invariants
6. Identify failure modes
7. Propose a minimal implementation
8. Implement
9. Run tests
10. Run lint/type checks
11. Run integration tests
12. Compare implementation against architecture
13. Report deviations
14. Stop if a requirement is ambiguous
```

Important rule:

> If the AI discovers an architectural ambiguity, it must stop and ask or propose alternatives. It must not invent a requirement.

---

# 5. Repository Structure

Start with a modular monolith.

Do NOT start with microservices.

Suggested structure:

```text
llm-gateway/
├── docs/
│   ├── product.md
│   ├── architecture.md
│   ├── decisions/
│   ├── experiments/
│   └── evaluation/
│
├── src/
│   ├── api/
│   ├── application/
│   ├── domain/
│   ├── cache/
│   ├── embeddings/
│   ├── providers/
│   ├── routing/
│   ├── policy/
│   ├── tenancy/
│   ├── observability/
│   └── infrastructure/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── contract/
│   ├── load/
│   └── evaluation/
│
├── scripts/
├── docker/
├── product.md
├── architecture.md
├── loop.md
└── README.md
```

Keep boundaries clear even though the first deployment is one service.

---

# 6. Weekly Architecture Roadmap

The project should evolve through these architectures.

## Week 1 — Gateway Core

```text
Client
  |
  v
HTTP API
  |
  v
Request validation
  |
  v
Provider adapter
  |
  v
LLM
  |
  v
Response
```

Focus:

- HTTP contracts
- OpenAI-compatible request shape
- provider abstraction
- errors
- timeouts
- cancellation
- streaming

Deliverable:

A client can send an LLM request through your gateway and receive the response.

---

## Week 2 — Exact Cache

```text
Client
  |
  v
Gateway
  |
  v
Normalize
  |
  v
Exact Cache
  |       \
 HIT      MISS
  |         |
  |         v
  |       LLM
  |         |
  |         v
  |      Cache Write
  |         |
  +---------+
      |
      v
    Client
```

Focus:

- canonical request representation
- hashing
- Redis
- TTL
- cache hit/miss
- serialization
- cache-aside pattern
- graceful Redis failure

Deliverable:

Repeated identical requests avoid the LLM call.

---

## Week 3 — Semantic Cache

```text
Request
   |
   v
Normalize
   |
   v
Embedding
   |
   v
Vector Search
   |
   v
Candidate Matches
   |
   v
Similarity Threshold
   |
   v
Reuse Policy
```

Focus:

- embeddings
- cosine similarity
- vector search
- ANN/HNSW concepts
- thresholds
- candidate retrieval
- semantic cache metadata

Deliverable:

Equivalent requests can reuse previous responses.

---

## Week 4 — Correctness + Concurrency

```text
                  Request
                     |
          +----------+----------+
          |                     |
       Exact                 Semantic
          |                     |
          +----------+----------+
                     |
                Reuse Policy
                     |
              +------+------+
              |             |
             HIT           MISS
                            |
                       Single Flight
                            |
                         Provider
```

Focus:

- similarity versus equivalence
- prompt/model identity
- cache admission
- freshness
- single-flight/request coalescing
- stampede prevention
- race conditions
- concurrent requests

Deliverable:

The cache is difficult to misuse and behaves correctly under concurrency.

---

## Week 5 — Multi-Tenancy + Reliability

```text
                    Gateway
                       |
                 Tenant Context
                       |
        +--------------+--------------+
        |              |              |
     Tenant A       Tenant B       Tenant C
        |              |              |
     policies       policies       policies
     quotas         quotas         quotas
     cache          cache          cache
```

Focus:

- tenant isolation
- quotas
- rate limiting
- timeouts
- retries
- circuit breakers
- backpressure
- graceful degradation

Deliverable:

One tenant cannot accidentally read another tenant's cache data.

---

## Week 6 — Observability + Cost

```text
Gateway
  |
  +--> Metrics
  |
  +--> Logs
  |
  +--> Traces
  |
  +--> Cost accounting
  |
  +--> Cache analytics
```

Track:

```text
requests_total
exact_cache_hits
semantic_cache_hits
cache_misses
provider_requests
provider_latency
cache_latency
tokens_in
tokens_out
estimated_cost
estimated_cost_saved
semantic_similarity
errors
timeouts
rate_limit_events
```

Deliverable:

You can explain what the gateway is doing without reading application logs manually.

---

## Week 7 — Evaluation Harness

```text
Evaluation Dataset
        |
        v
     Gateway
        |
        v
Cache Decisions
        |
        v
Expected vs Actual
        |
        v
Precision / Recall
        |
        v
Cost + Latency
```

Build datasets containing:

- exact duplicates
- paraphrases
- related but non-equivalent questions
- different dates
- different numbers
- different constraints
- different system prompts
- different tenants
- different models

Measure:

```text
exact hit rate
semantic hit rate
safe reuse rate
false positive reuse
false negative reuse
precision
recall
latency
cost saved
```

Deliverable:

You can defend your threshold and cache design with data.

---

## Week 8 — Hardening + Interview Version

Focus on:

- load testing
- failure injection
- documentation
- architecture diagrams
- ADRs
- benchmark results
- security review
- README
- deployment
- demo

Deliverable:

A project another engineer can run, inspect, benchmark, and understand.

---

# 7. Daily Architecture

Every day should follow the same loop.

```text
MORNING
  |
  +-- 30-60 min focused learning
  |
  +-- 15 min architecture review
  |
  +-- define ONE engineering objective
  |
  v
BUILD
  |
  +-- implement one bounded component
  +-- write tests
  +-- run experiments
  |
  v
VALIDATE
  |
  +-- unit tests
  +-- integration tests
  +-- failure cases
  +-- compare against architecture
  |
  v
DOCUMENT
  |
  +-- what changed
  +-- why
  +-- tradeoffs
  +-- what failed
  +-- what you learned
  |
  v
STOP
```

Do not measure progress by lines of code.

Measure:

```text
concept understood
+
behavior implemented
+
failure mode tested
+
decision documented
```

---

# 8. First Two Weeks — Exact Daily Plan

## Day 1 — Understand the Gateway

Learn:

- reverse proxy
- API gateway
- HTTP request lifecycle
- provider abstraction
- timeouts
- streaming

Build:

```text
POST /v1/chat/completions
        |
        v
Gateway
        |
        v
Provider Adapter
        |
        v
LLM
```

Do not add caching.

AI task:

- review your API contract
- identify missing failure cases
- implement only the provider adapter and tests

End-of-day proof:

- request works
- invalid request fails correctly
- provider timeout is handled
- provider error is normalized

---

## Day 2 — Request Model + Normalization

Learn:

- canonicalization
- deterministic serialization
- request identity

Build:

```text
Raw Request
    |
    v
Normalized Request
    |
    v
Canonical JSON
    |
    v
Hash
```

Experiment with:

```text
different JSON field order
extra optional defaults
whitespace
message ordering
temperature defaults
```

Your goal is to understand exactly when two requests are considered identical.

---

## Day 3 — Redis Fundamentals

Learn:

- key/value storage
- TTL
- atomic operations
- eviction
- persistence at a conceptual level

Build a tiny Redis experiment before integrating it.

Then create:

```text
CacheRepository
```

with operations such as:

```text
get
set
delete
exists
```

Do not expose Redis directly to the application layer.

---

## Day 4 — Exact Cache

Implement:

```text
request
  |
  v
normalize
  |
  v
hash
  |
  v
Redis
```

Test:

- hit
- miss
- expiration
- malformed cached data
- Redis unavailable
- cache overwrite
- concurrent requests

Important invariant:

```text
Cache failure must not automatically become LLM failure.
```

---

## Day 5 — Cache Correctness

Study:

- cache-aside
- cache stampede
- stale data
- invalidation
- TTL tradeoffs

Build experiments for concurrent misses.

Do not solve every problem yet.

Document:

```text
What problem exists?
What is the simplest solution?
What does it cost?
When will we implement it?
```

---

## Day 6 — Streaming

Learn:

- HTTP streaming
- SSE
- buffering
- partial responses
- cancellation

Implement streaming provider responses through the gateway.

Then answer:

> What exactly gets cached for a streaming response?

Design the answer before coding.

---

## Day 7 — Weekly Review

Do not add features.

Run:

```text
unit tests
integration tests
manual API tests
failure tests
load experiment
```

Write:

```text
docs/weekly/week-01.md
```

Include:

- architecture
- implemented features
- failed approaches
- important concepts learned
- unresolved issues
- next week's risks

If you cannot explain the request lifecycle from client to provider, do not move forward.

---

# 9. Week 2 Daily Plan — Exact Cache Maturity

## Day 8

Study:

- cache-aside
- write-through
- write-back
- TTL strategies

Choose cache-aside and document why.

---

## Day 9

Study:

- cache key design
- canonicalization
- hashing

Create a deterministic request fingerprint.

Test it with a large matrix of equivalent and non-equivalent inputs.

---

## Day 10

Study:

- concurrency
- atomicity
- locks
- single-flight

Build a small standalone single-flight experiment.

Do not immediately integrate it.

---

## Day 11

Integrate single-flight into the gateway.

Test:

```text
100 identical concurrent requests
```

Expected behavior:

```text
1 provider request
99 requests share result
```

The exact implementation can evolve; the invariant is what matters.

---

## Day 12

Study:

- cache eviction
- memory pressure
- TTL
- hot keys

Run experiments.

Record latency and behavior.

---

## Day 13

Implement cache metrics:

```text
hit
miss
latency
provider avoided
```

Do not build dashboards yet.

---

## Day 14

Weekly review.

You should now be able to explain:

```text
request identity
cache-aside
TTL
stampede
single-flight
graceful degradation
```

If not, stop feature development and close the conceptual gaps.

---

# 10. Weeks 3–4 Daily Direction

## Week 3

### Day 15
Learn embeddings and vector representations.

### Day 16
Implement a tiny embedding experiment outside the gateway.

### Day 17
Learn cosine similarity and distance.

### Day 18
Build a tiny semantic-search experiment.

### Day 19
Learn ANN and HNSW conceptually.

### Day 20
Implement vector candidate retrieval.

### Day 21
Integrate semantic cache behind the exact cache.

Architecture:

```text
Exact Cache
    |
   miss
    |
Semantic Cache
    |
   miss
    |
Provider
```

---

## Week 4

### Day 22
Study similarity vs equivalence.

Build a labeled test dataset.

### Day 23
Study cache safety.

Define which request fields affect reuse.

### Day 24
Implement cache metadata:

```text
tenant
model
model version
prompt fingerprint
generation parameters
created_at
expires_at
embedding
response
```

### Day 25
Implement reuse policy.

### Day 26
Test false positives.

This is one of the most important days.

### Day 27
Test false negatives.

### Day 28
Benchmark threshold choices.

Do not choose a threshold because a tutorial says 0.9.

Choose it based on your evaluation data and document the tradeoff.

---

# 11. Weeks 5–8 Daily Direction

## Week 5 — Reliability + Tenancy

Day 29: tenant model

Day 30: tenant-isolated cache keys

Day 31: rate limiting

Day 32: quotas

Day 33: retries and timeout policy

Day 34: circuit breaker / provider failure handling

Day 35: failure injection and review

---

## Week 6 — Observability

Day 36: structured logging

Day 37: metrics

Day 38: distributed tracing concepts

Day 39: latency breakdown

Day 40: token accounting

Day 41: cost estimation

Day 42: observability review

---

## Week 7 — Evaluation

Day 43: evaluation dataset design

Day 44: exact-match evaluation

Day 45: semantic-equivalence evaluation

Day 46: false-positive analysis

Day 47: threshold sweep

Day 48: latency/cost benchmark

Day 49: evaluation report

---

## Week 8 — Production Hardening

Day 50: load test

Day 51: failure injection

Day 52: security review

Day 53: API/documentation cleanup

Day 54: architecture diagrams

Day 55: deployment

Day 56: final benchmark + README + interview preparation

---

# 12. What You Should Learn During the Project

Do not try to master every topic before implementing it.

Use this order.

### Backend fundamentals

Learn deeply:

- HTTP
- HTTP streaming
- REST/API contracts
- timeouts
- retries
- cancellation
- concurrency
- connection pooling

### Caching

Learn deeply:

- cache-aside
- TTL
- eviction
- invalidation
- cache stampede
- single-flight
- hot keys
- consistency

### Redis

Understand:

- strings
- hashes
- TTL
- atomic commands
- transactions conceptually
- Lua/scripts conceptually
- memory behavior
- eviction policies

### Vector search

Understand:

- embeddings
- cosine similarity
- Euclidean distance
- nearest-neighbor search
- ANN
- HNSW
- recall/latency tradeoffs

### LLM infrastructure

Understand:

- model abstraction
- provider abstraction
- token usage
- streaming
- generation parameters
- prompt versions
- model versions
- cost

### Distributed systems

Understand:

- retries
- idempotency
- timeouts
- backpressure
- circuit breakers
- concurrency control
- graceful degradation

### Observability

Understand:

- logs
- metrics
- traces
- latency percentiles
- cardinality
- correlation/request IDs

---

# 13. Your Daily Learning Method

For every new topic:

```text
1. Read the official documentation / authoritative explanation.
2. Explain the concept to yourself without looking.
3. Build a 20–50 line experiment.
4. Break the experiment intentionally.
5. Observe the failure.
6. Integrate the concept into the gateway.
7. Write a short decision note.
```

For example, for HNSW:

Do NOT:

```text
"Learn HNSW"
```

Do:

```text
What problem does ANN solve?
Why is brute-force vector search expensive?
What does HNSW approximate?
What does recall mean here?
What latency tradeoff exists?
What happens when I change search parameters?
```

Then run an experiment.

---

# 14. AI Prompt Structure

For implementation sessions, use this structure:

```text
ROLE:
You are a senior backend engineer reviewing an existing
LLM gateway. You must preserve the architecture.

CONTEXT:
Read:
- product.md
- architecture.md
- loop.md
- relevant source files
- relevant tests

TASK:
Implement only:
<one bounded task>

CONSTRAINTS:
- Do not change public APIs unless explicitly required.
- Do not introduce new dependencies without explaining why.
- Do not change architecture silently.
- Do not delete tests.
- Do not weaken validation to make tests pass.
- Prefer small, composable changes.

BEFORE CODING:
1. Explain the current design relevant to the task.
2. List assumptions.
3. List failure modes.
4. List files that need modification.
5. Identify any ambiguity.

IMPLEMENT:
Make the smallest change that satisfies the requirement.

VALIDATE:
Run:
- unit tests
- integration tests
- type checks
- lint
- relevant benchmark/experiment

FINAL REPORT:
- what changed
- why
- tests run
- failures
- architecture deviations
- remaining risks
```

The important part is:

> AI should operate inside your architecture, not create the architecture while coding.

---

# 15. Architecture Documents

Keep these documents alive throughout the project.

## product.md

Defines:

```text
What are we building?
Who uses it?
What problem does it solve?
What is in scope?
What is out of scope?
What does success mean?
```

## architecture.md

Defines:

```text
components
data flow
interfaces
data models
failure behavior
cache semantics
tenant isolation
observability
deployment
```

## loop.md

Defines:

```text
how AI is allowed to modify the system
```

## ADRs

Create an ADR whenever you make an important decision.

Examples:

```text
ADR-001 Modular monolith first
ADR-002 OpenAI-compatible API
ADR-003 Cache-aside
ADR-004 Redis for exact cache
ADR-005 Vector store choice
ADR-006 Semantic threshold strategy
ADR-007 Tenant isolation strategy
ADR-008 Single-flight strategy
```

---

# 16. Daily Architecture Artifact

At the end of every day, update:

```text
docs/daily/YYYY-MM-DD.md
```

Use:

```text
# Daily Engineering Log

## Objective

What did I intend to build?

## Concept

What concept did I learn?

## Architecture

What changed?

## Implementation

What did I actually implement?

## Tests

What did I verify?

## Failure Cases

What broke?

## Decision

What did I decide and why?

## AI Usage

What did AI implement/review?

## Understanding Check

Can I explain this without AI?

## Tomorrow

What is the single next engineering objective?
```

The "Understanding Check" is important.

If the answer is no, don't hide behind working code.

---

# 17. Weekly Architecture Artifact

At the end of each week:

```text
docs/weekly/week-N.md
```

Use:

```text
# Week N Review

## Goal

## Architecture at Start

## Architecture at End

## Features Completed

## Concepts Learned

## Experiments

## Benchmarks

## Bugs

## Failure Modes Discovered

## Architectural Decisions

## AI Mistakes / Misunderstandings

## What I Can Explain Now

## What I Still Don't Understand

## Risks

## Next Week

## Definition of Done
```

This creates a record of your engineering thinking.

---

# 18. Definition of Done

Never say:

> "The feature works."

Instead use:

```text
[ ] Requirement implemented
[ ] Unit tests
[ ] Integration tests
[ ] Failure cases tested
[ ] Concurrency considered
[ ] Observability added
[ ] Architecture updated
[ ] ADR created if needed
[ ] README/documentation updated
[ ] AI-generated assumptions reviewed
[ ] I can explain the implementation without AI
```

For major features, also require:

```text
[ ] Benchmark
[ ] Load test
[ ] Failure injection
```

---

# 19. Weekly Health Check

Every Sunday, score yourself only on completion state, not "quality":

```text
Architecture understood?       YES / NO
Feature implemented?           YES / NO
Tests passing?                 YES / NO
Failure cases tested?          YES / NO
Benchmark completed?           YES / NO
Documentation updated?         YES / NO
Can explain without AI?        YES / NO
```

If several answers are NO, reduce next week's scope instead of adding more features.

---

# 20. The Most Important Rule

Do not optimize for:

```text
number of features
number of files
number of technologies
lines of code
```

Optimize for:

```text
depth of understanding
correctness
measurable behavior
failure handling
architectural clarity
```

A gateway with:

```text
Node/Go
+
HTTP
+
Redis
+
one vector store
+
one provider
+
good tests
+
evaluation
+
observability
```

is more valuable than a gateway with:

```text
10 providers
+
5 databases
+
Kubernetes
+
Kafka
+
microservices
```

that you cannot explain.

---

# 21. Final System You Should Be Able to Explain

At the end, you should be able to draw this from memory:

```text
                           CLIENTS
                              |
                              v
                    +-------------------+
                    |   API / Auth      |
                    +---------+---------+
                              |
                              v
                    +-------------------+
                    | Request Normalize |
                    +---------+---------+
                              |
                              v
                    +-------------------+
                    | Exact Cache       |
                    +---------+---------+
                              |
                         cache miss
                              |
                              v
                    +-------------------+
                    | Semantic Cache    |
                    +---------+---------+
                              |
                         candidate
                              |
                              v
                    +-------------------+
                    | Reuse Policy      |
                    +---------+---------+
                              |
                           unsafe/miss
                              |
                              v
                    +-------------------+
                    | Single Flight     |
                    +---------+---------+
                              |
                              v
                    +-------------------+
                    | Model Router      |
                    +---------+---------+
                              |
                  +-----------+-----------+
                  |           |           |
                  v           v           v
               Provider A  Provider B  Provider C
                  |           |           |
                  +-----------+-----------+
                              |
                              v
                    +-------------------+
                    | Response Processor|
                    +---------+---------+
                              |
                    +---------+---------+
                    |                   |
                    v                   v
              Cache Admission      Observability
                    |                   |
                    v                   v
              Exact/Semantic       Metrics/Logs/
                 Storage             Traces/Cost
                    |
                    v
                  CLIENT
```

And you should be able to explain:

```text
Why exact cache comes before semantic cache.
Why similarity is not equivalence.
Why cache metadata matters.
Why tenant isolation matters.
Why cache failure should degrade gracefully.
Why concurrent misses create a stampede.
Why single-flight helps.
Why TTL is not enough for every type of data.
Why model/prompt versions affect cache validity.
How semantic thresholds affect false positives and false negatives.
How you measured whether the cache actually saves money.
How you know the semantic cache is safe enough to use.
```

That is the actual learning target.

The code is the artifact; the architecture and reasoning are the skill.
