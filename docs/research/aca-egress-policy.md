# ACA Sandboxes egress: expression, defaults, and raw sockets

Investigation date: **2026-09-11**. This is about **ACA Sandboxes**, not
ordinary Container Apps ingress or Dynamic Sessions. No muxterm implementation
or design rewrite is included.

## Verdict

**According to Microsoft's documentation, a raw non-HTTP socket bypasses
host-based rules in `Partial` or `Legacy` mode (and `None` disables the rules),
but `Full` mode blocks it.** **[READ + INFERENCE]**

The inference is the classification of that socket's traffic as non-HTTP; the
mode behavior itself is explicitly documented in [Microsoft Learn][learn-egress].
This is **not a successful live-probe result**. The one disposable sandbox was
created and destroyed, but the probe failed locally before executing a traffic
test; see the [run record](#disposable-sandbox-run-and-teardown).

**Attaching a policy is not synonymous with default-deny network containment.**
The policy's `defaultAction` and `trafficInspection` must both be specified
deliberately. The documented containment configuration is `defaultAction: Deny`
plus `trafficInspection: Full`, with narrow host allow rules. **[READ]**

### Evidence markers

- **VERIFIED** — observed directly during this investigation; limited to exactly
  the command output, bytes, or resource read-back described.
- **READ** — stated in the cited authoritative document or published SDK source.
- **INFERENCE** — reasoned from evidence, with the reasoning stated.
- **UNKNOWN** — not established; the reason is stated. An unknown does not
  invalidate the independently established answers.

## Q1. What can EgressRule and EgressHostRule match?

**[READ + VERIFIED]** The [Python SDK reference][sdk] and the locally emitted
[`aca sandbox egress schema` transcript][cli-schema] agree on these shapes:

```text
EgressHostRule:  pattern, action
EgressRule:      name, match, action
EgressRuleMatch: host, path, methods
```

`name` identifies an advanced rule; it is not a traffic match dimension.
Wire field names are used here; the Python SDK uses snake_case where relevant.

| Match dimension | EgressHostRule | EgressRule.match | Evidence |
|---|---|---|---|
| Exact hostname | **Yes:** `pattern`, e.g. `example.com` | **Yes:** `host` | **[READ]** Portal egress guide: “Required host name or wildcard pattern”; literal-host examples for both forms. |
| Wildcard FQDN | **Yes:** `pattern`, e.g. `*.github.com` | **Yes:** `host` glob | **[READ + VERIFIED]** SDK example and CLI schema's “Host glob pattern.” |
| Destination IP address | **No IP-address match field** | **No IP-address match field** | **[VERIFIED]** Complete emitted field lists above; **[INFERENCE]** these models do not express a packet destination-address ACL. |
| CIDR/subnet | **No** | **No** | **[VERIFIED]** No CIDR field in either model's CLI schema; corroborated by the SDK reference. |
| Port number | **No** | **No** | **[VERIFIED]** No port field in either match model. |
| L4 protocol, TCP/UDP | **No** | **No** | **[VERIFIED]** No L4 protocol field in either match model. |
| HTTP path | **No** | **Yes:** optional `path` glob | **[READ + VERIFIED]** SDK and CLI schema. |
| HTTP method | **No** | **Yes:** optional `methods` list | **[READ + VERIFIED]** SDK and CLI schema, e.g. `GET`, `POST`. |

**[UNKNOWN]** Whether a numeric HTTP Host value can be used as a host pattern,
or whether a host pattern containing `:port` is accepted with special semantics,
was not established. A string that resembles an IP is not evidence of IP/CIDR
packet matching. The schema does not prohibit all extra properties, so its
field lists alone also do not prove that the server rejects every unknown key.
The answers above describe the exposed, documented match dimensions.

**[READ]** The broader [Learn overview][overview] mentions “CIDR-based network
rules,” but supplies no corresponding field in these two egress rule models.
That general statement must not be substituted for their concrete schema.
Likewise, `sourceCidrs`/`IpAccessControl` strings and the ingress `Http`/`Http2`
enum are **not egress match fields**.

## Q2. What are the possible values of EgressRuleAction?

**[READ + VERIFIED]** `EgressRuleAction` is an **object**, not itself a string
enum. Its `type` discriminator has exactly these documented/schema values:

| `EgressRuleAction.type` | Meaning in the Learn egress guide |
|---|---|
| `Allow` | Allow the request unchanged. |
| `Deny` | Block the request. |
| `Transform` | Allow it while modifying headers. |
| `Rewrite` | Allow it while rewriting the destination scheme, host, or path. |

The object's other fields are `host`, `path`, `scheme`, and `headers`.
Those are **action data**, not additional match dimensions.
`EgressHostRule.action` and `EgressPolicy.defaultAction` are narrower:
only **`Allow` or `Deny`**. Sources: [SDK models][sdk] and
[Learn, Rule actions][learn-egress], corroborated by the local CLI schema.

## Q3. What happens when no rule matches?

**[READ]** For requests evaluated by the policy, **the configured
`defaultAction` wins**: `Deny` denies; `Allow` allows. There is no universal
“policy attached means deny” posture.

The [Learn egress guide][learn-egress] states:

> “Allow or Deny. Applied to any request that doesn't match a more specific rule.”
>
> “Default action is applied when no rule matches.”

Do not extend that request-level fallback to protocols which the selected
inspection mode permits outside rule enforcement; Q4 is the other half of
the answer. With `None`, no egress rules are applied at all. **[READ]**

These defaults are distinct:

| Context | Established default or requirement | Evidence |
|---|---|---|
| No egress policy | Unrestricted outbound access; policies are opt-in. | **[READ]** [Portal, Control egress][portal-egress]. |
| CLI `egress set` | `--default` is required. | **[VERIFIED]** Local `--help`. |
| CLI policy-file schema | `defaultAction` is required, enum `Allow`/`Deny`. | **[VERIFIED]** Local `egress schema`. |
| CLI `egress init` template | Explicit `defaultAction: Deny`, `trafficInspection: Full`. | **[VERIFIED]** Local template output; a template choice, not a service default. |
| Python `EgressPolicy()` model, 0.1.0b4 | `default_action="Allow"`; `traffic_inspection=None` omits that wire property. | **[READ]** Published [SDK source distribution][sdk-source], `_model_types/_egress.py`. |
| Python `set_egress_default()` helper | Its argument defaults to `"Deny"`. | **[READ]** [SDK reference][sdk]; distinct from the model constructor. |
| Service receives a policy with `trafficInspection` omitted | **UNKNOWN:** neither guide nor SDK specifies which mode the server chooses. The attempted probe did not reach policy read-back. | **[UNKNOWN]** |
| Service receives `defaultAction` omitted | **UNKNOWN:** no authoritative omitted-field service behavior established; this is outside the emitted CLI schema. | **[UNKNOWN]** |

**[INFERENCE]** Do not infer a server default from a client constructor, a
helper's argument default, or a sample YAML file: those are different layers
and already disagree on `Allow` versus `Deny`.

## Q4. What happens to non-HTTP traffic?

**[READ]** [Learn's Traffic inspection table][learn-egress] is explicit:

| `trafficInspection` | Authoritative wording |
|---|---|
| `Full` | “All traffic is inspected. Deny rules are enforced, and non-HTTP traffic is blocked.” |
| `Partial` | “Only traffic that matches a rule is inspected. Non-HTTP traffic is allowed.” |
| `None` | “No egress rules are applied.” |
| `Legacy` | “All traffic is inspected. Non-HTTP traffic is allowed.” |

Applied to the requested protocols:

| Traffic | `Full` | `Partial` / `Legacy` | `None` | Evidence and limit |
|---|---|---|---|---|
| Raw TCP to an IP and port, carrying **non-HTTP** bytes | Blocked as non-HTTP, not governed by a configurable TCP/IP/port rule | Non-HTTP allowed; host rules do not contain it | Unaffected by the egress rules | **[INFERENCE]** Apply the documented non-HTTP behavior to this traffic class; no successful live test. |
| SSH over TCP port 22 | Blocked as non-HTTP | Non-HTTP allowed | Unaffected by the egress rules | **[INFERENCE]** SSH is not HTTP; there is no configurable port-22 match field. |
| Guest-originated DNS to an external resolver, UDP/53 or TCP/53 | Expected blocked as non-HTTP | Expected allowed as non-HTTP | Unaffected by the egress rules | **[INFERENCE]** Conventional DNS is non-HTTP, but the documents do not discuss DNS specifically. |
| Ordinary name resolution through the sandbox/platform resolver | **UNKNOWN** | **UNKNOWN** | **UNKNOWN** | Neither document specifies resolver exceptions, proxy-side DNS, or the guest resolver path. No DNS test executed. |

“Allowed” means **not denied by this policy mechanism**; it is not a guarantee
that routing, an upstream firewall, or the remote endpoint accepts a connection.
A raw socket carrying HTTP is still HTTP: the API used to open a socket does
not decide its application protocol. DNS-over-HTTPS is also not conventional
UDP/TCP DNS. **[INFERENCE]**

**[UNKNOWN]** The precise failure stage under `Full` is not established: these
sources do not say whether `connect()` fails, or whether an interception proxy
accepts a connection and later refuses its non-HTTP exchange. Nor do they
establish separate behavior for arbitrary non-HTTP TLS with SNI. Do not turn
“non-HTTP blocked” into a measured packet-level guarantee.

**[READ]** The newer portal guide tells readers to “verify exact transport
behavior in the current product or CLI help.” The CLI help names the modes,
but does not independently describe their enforcement. Accordingly, the table
above retains Learn's claims as **READ**, not **VERIFIED**.

**[READ]** The SDK additionally exposes create-time `skip_egress_proxy`,
described as “Whether to bypass the egress proxy.” It is a separate control.
**[INFERENCE]** The containment recommendation assumes the proxy is not
bypassed. Its omitted service default and interactions with a supplied policy
are **[UNKNOWN]**.

## Q5. What is EgressSecretRef for?

**[READ + VERIFIED]** It is a **source for an outbound HTTP-header value**,
referencing a secret stored in the sandbox group rather than putting that
credential in the sandbox's code or environment.

The wire nesting is:

```text
rules[].action.headers[].valueRef.secretRef
    secretId   required; identifies the sandbox-group secret
    secretKey  optional; selects a key within that secret
    format     optional; substitutes the resolved value into a template
```

The CLI schema says the server picks a default key if `secretKey` is omitted.
The Python names are `secret_id`, `secret_key`, `format`.
Learn gives `Bearer {value}` as an example format. No sandbox-group secret was
created, read, or used in this investigation. **[READ + VERIFIED]**

This reference is used by header mutations for `Transform`/`Rewrite`, not for
matching traffic or authenticating SSH/DNS. It is distinct from
`managedIdentityRef`, which sources a managed-identity token. The documented
purpose is proxy-side credential injection; this is not a proof that every
allowed upstream or policy configuration prevents credential disclosure.
Sources: [SDK EgressSecretRef][sdk], [Learn credential injection][learn-egress],
and the emitted CLI schema.

## Static-source record

### Complete local `aca sandbox egress` command and flag tree

**[VERIFIED]** `/usr/local/bin/aca --version` returned `aca 1.0.0-preview.1`.
The binary is a stripped x86-64 Rust ELF. Its SHA-256 was:

```text
867744df9965a983c1501292f72727862476b2f4b298ef3c8f8d7abfd5337b09
```

The full static schema output is preserved as
[`aca-egress-schema-1.0.0-preview.1.json`][cli-schema], generated with:

```sh
/usr/local/bin/aca sandbox egress schema > aca-egress-schema-1.0.0-preview.1.json
```

Its SHA-256 is:

```text
b5a9c36f292dbe5173ec9cdc0415b2b4843f80416659cb74c721844b0c7b88b8
```

This transcript contains schema descriptions, not a live sandbox's policy or
secret values. It preserves the field lists, enums, required properties, and
the `secretKey` omission description cited above. **[VERIFIED]**

Every real subcommand's `--help` was read. None has further operational
subcommands. The help dispatcher was inspected with `egress help` and
`egress help help`; `egress help --help` treats `--help` as a subcommand name
and returns a usage error.

```text
aca sandbox egress
  set        --group GROUP
             (--id ID | -l/--selector SELECTOR)
             --default DEFAULT_ACTION             [required]
             --rule RULE                          [pattern:Allow or pattern:Deny]
             --traffic-inspection MODE            [Legacy, Full, Partial, None]
             -h/--help
  apply      --group GROUP
             (--id ID | -l/--selector SELECTOR)
             --file FILE                          [required; YAML policy]
             -h/--help
  show       --group GROUP; (--id ID | -l/--selector SELECTOR); -h/--help
  export     --group GROUP; (--id ID | -l/--selector SELECTOR); -h/--help
  decisions  --group GROUP; (--id ID | -l/--selector SELECTOR); -h/--help
  schema     -h/--help
  init       -h/--help
  help       [COMMAND]...
```

The parent, all seven operational leaves, and their inherited options expose:

```text
-s/--subscription SUBSCRIPTION
-g/--resource-group RESOURCE_GROUP
-o/--output OUTPUT                            [default: table]
--verbose
--debug
--managed-identity [MANAGED_IDENTITY]          [system or client-id]
--region REGION
```

The parent, `schema`, and `init` also list inherited `--sandbox-group GROUP`.
The resource-targeting leaves list their own `--group GROUP` instead.
Environment fallbacks named in help are `ACA_SUBSCRIPTION`,
`ACA_RESOURCE_GROUP`, `ACA_SANDBOX_GROUP`, `ACA_SANDBOX_MANAGED_IDENTITY`,
and `ACA_REGION`. Parent `-h/--help` prints the command tree.
Selectors use label expressions; they do not describe network match rules.

`schema` and `init` print static content; neither attaches a policy nor creates
an Azure resource. Neither verbose nor debug logging was enabled. The latter
explicitly warns it may log sensitive data. **[VERIFIED]**

### Binary strings, beyond merely spotting struct names

**[VERIFIED]** Printable byte windows around the names and field table were
read directly from the binary, including these file offsets:

| Offset | Observed evidence |
|---|---|
| `0x78d62` | `struct EgressHostRule with 2 elements` |
| `0x78d87` | `struct EgressSecretRef with 3 elements` |
| `0x78dff` | `struct EgressRuleMatch with 3 elements` |
| `0x78e25` | `struct EgressRuleAction with 5 elements` |
| `0x78e4c` | `struct EgressRule with 3 elements` |
| `0x78e6d` | `struct EgressPolicy with 4 elements` |
| `0x78944` onward | Concatenated field strings including `defaultAction`, `secretKey`, `format`, `secretRef`, `methods`, `match`, `hostRules`, `trafficInspection`. |
| `0x7a6b6` | Embedded schema's `trafficInspection` enum: `Legacy`, `Full`, `Partial`, `None`. |
| `0x7ac70` onward | Embedded schema's `methods` field and `action.type` enum: `Allow`, `Deny`, `Transform`, `Rewrite`. |

**[INFERENCE]** Adjacency in a stripped binary alone cannot reliably assign
every field to a struct. The emitted structured schema and SDK reference make
that assignment; neither a struct name nor an enum string proves runtime
network enforcement.

### Requested public ARM specification: version-specific limitation

**[VERIFIED]** A public
`Microsoft.App/sandboxGroups@2026-02-01-preview` specification could not be
located in the checked official surfaces:

- [Expected preview SandboxGroups.json][arm-preview] returned 404; the
  [public ContainerApps preview directory][arm-preview-dir] has no
  `2026-02-01-preview` directory. History lookups for that version's
  `SandboxGroups.json` and combined `openapi.json` returned empty lists.
- [Microsoft.App JSON resource schema for that version][arm-schema] returned
  404. The corresponding `azure-resource-manager-schemas` version directory
  exists but contains no `Microsoft.App.json`.
- [Learn's version-specific sandboxGroups template page][arm-template] returned
  404.

**[READ]** The [Bicep quickstart][bicep] does use
`Microsoft.App/sandboxGroups@2026-02-01-preview`; that is evidence of the
resource/version, not a substitute for an unavailable public specification.

As a **separately versioned cross-check**, the public
[`2026-07-01/openapi.json`][arm-current], pinned at repository commit
`c20bf553ad64f20c6d5e3f56080380c086cb1fde`, was inspected. Its sandbox-group
properties are `environmentId`, `defaultDomain`, and `provisioningState`, plus
inherited ARM resource metadata, `location`, and `tags`. It contains **zero**
occurrences of `EgressPolicy`, `EgressRule`, `EgressHostRule`, `EgressSecretRef`,
or `trafficInspection`. **[READ + VERIFIED]**

**[INFERENCE]** This accords with the documented separation between ARM
sandbox-group management and ADC data-plane resources such as egress policies.
The July spec is **not** presented as the requested February spec and does
not establish February's packet behavior. The exact February public ARM
contract remains **[UNKNOWN]**; it does not block the data-plane answers above.

## Disposable sandbox run and teardown

**[VERIFIED]** Exactly **one** sandbox was created, in West US 2, in an
existing sandbox group. The smallest [documented tier][limits] was requested:
`--disk ubuntu --cpu 250m --memory 512Mi`. The create request supplied
`--egress-default Deny --egress-rule example.com:Allow` and deliberately
omitted `--traffic-inspection` to investigate the undocumented default.
No credentials, volumes, exposed ports, identity assignments, resource groups,
or standalone policy resources were requested.

**[VERIFIED]** The local harness attempted to parse the create command's
stdout as JSON and failed:

```text
Expecting value: line 1 column 1 (char 0)
```

The `finally` cleanup then rediscovered the sandbox by the unique run label
and deleted it by its exact ID. No `exec`, non-HTTP test, policy read-back,
policy update, or lifecycle-policy update ran. **The empirical protocol-test
requirement was not completed.** This was a **local probe-harness failure**,
not missing subscription access, missing RBAC, quota refusal, or a preview
feature refusal. No second sandbox was created.

Sanitized run record, all timestamps UTC on 2026-09-11:

| Time | Observation | Evidence |
|---|---|---|
| `06:26:57.448` | Run began; unique-label sandbox list empty; group volume list empty. | **[VERIFIED]** |
| `06:26:58.535` | One smallest-tier sandbox create request began. | **[VERIFIED]** |
| `06:26:59.785` | JSON parsing failed; cleanup began. | **[VERIFIED]** |
| `06:27:07.479` | Exact-ID delete returned exit 0. | **[VERIFIED]** |
| Before `06:27:09.650` | Exact-ID sandbox GET returned **404**, title `SandboxNotFound`, detail `Requested document not found.` | **[VERIFIED]** |
| Before `06:27:09.650` | Exact-ID `egress show` also returned **404**. | **[VERIFIED]** |
| `06:27:09.650` | Unique-label sandbox list empty; group volume list still empty; cleanup verified. | **[VERIFIED]** |

The sandbox ID, subscription coordinates, and unrelated sandbox identifiers
are intentionally not copied into this public document. Existing resources
were not deleted. There is no surviving resource from this run.

### Azure cost

**[INFERENCE, estimate — not a measured Azure bill]** Using the supplied
West US 2 rates of `$0.000034/vCPU-second` and `$0.000004/GiB-second`, the
requested 0.25 vCPU / 0.5 GiB shape is `$0.0000105/second`:

```text
12.202 seconds (entire run, including preflight and read-back)
  * (0.25 * $0.000034 + 0.5 * $0.000004)
  = approximately $0.000128 compute
```

The allocated tier was not read back before cleanup. For comparison, charging
the entire interval at the supplied **1 vCPU / 2 GiB** rate of `$0.1512/hour`
would be approximately **$0.000512 compute**. Estimated compute was therefore
well below one cent, before free grants. Ancillary meters and billing
rounding were not measured; no persistent volumes or snapshots remain.

## Consequence for the existing design

**[INFERENCE]** Section S5.3's identification of `EgressPolicy` as “the correct
answer,” and S1.4's Release 3 “actual isolation payoff,” are **too broad if
read as promises made merely by attaching host rules**. `Partial` and
`Legacy` explicitly allow non-HTTP; `None` disables rules. A documented
containment claim must specify **`Deny` + `Full`**, keep proxy bypass disabled,
and distinguish documented behavior from successful live verification.

This qualifies the Release 3 security claim rather than disproving the
possibility of containment. S5.3's no-policy/open-egress MVP statement is
supported by the portal guide. S5.4's blast-radius claims were not tested.
The original design was read for context and **not edited**; the transport
probe in section S2.5 remains out of scope.

## Sources

All accessed 2026-09-11. Portal documentation identifies itself as updated
2026-09-01; the Learn egress page reports 2026-06-02. Preview documentation can
change, so the direct quotations and local binary hash above matter.

- [Microsoft Learn: Egress policies and network controls][learn-egress] —
  default action, action kinds, credential injection, and mode behavior.
- [Azure Sandboxes portal: Control egress][portal-egress] — exact/wildcard
  hosts, policy fields, opt-in posture, explicit Deny/Full examples.
- [Official Python SDK reference, 0.1.0b4][sdk] — all named egress models.
- [Published Python SDK source distribution, 0.1.0b4][sdk-source] —
  `_model_types/_egress.py`, for constructor/serialization defaults.
- [Local CLI schema transcript, 1.0.0-preview.1][cli-schema] — unmodified static
  command output, paired with the binary and transcript hashes above.
- [Sandbox overview][overview], [Bicep quickstart][bicep], and the ARM links
  below — control-plane/data-plane distinction and version availability.
- [Portal limits and quotas][limits] — minimum 0.25 vCPU / 0.5 GiB.

[learn-egress]: https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-egress-policies
[portal-egress]: https://sandboxes.azure.com/docs/sandboxes/sandbox/egress
[sdk]: https://sandboxes.azure.com/docs/sandboxes/sdk-reference/python-sdk
[sdk-source]: https://files.pythonhosted.org/packages/b3/c3/e84c8ffbfa88776c16493e8373436264b1a9c4b5099756506c35041dcd87/azure_containerapps_sandbox-0.1.0b4.tar.gz
[cli-schema]: aca-egress-schema-1.0.0-preview.1.json
[overview]: https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-overview
[bicep]: https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-quickstart-bicep
[limits]: https://sandboxes.azure.com/docs/sandboxes/limits
[arm-preview]: https://raw.githubusercontent.com/Azure/azure-rest-api-specs/main/specification/app/resource-manager/Microsoft.App/ContainerApps/preview/2026-02-01-preview/SandboxGroups.json
[arm-preview-dir]: https://api.github.com/repos/Azure/azure-rest-api-specs/contents/specification/app/resource-manager/Microsoft.App/ContainerApps/preview
[arm-schema]: https://schema.management.azure.com/schemas/2026-02-01-preview/Microsoft.App.json
[arm-template]: https://learn.microsoft.com/en-us/azure/templates/microsoft.app/2026-02-01-preview/sandboxgroups
[arm-current]: https://raw.githubusercontent.com/Azure/azure-rest-api-specs/c20bf553ad64f20c6d5e3f56080380c086cb1fde/specification/app/resource-manager/Microsoft.App/ContainerApps/stable/2026-07-01/openapi.json