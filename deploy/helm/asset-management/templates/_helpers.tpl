{{- define "am.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/* Name of one component's resources, e.g. "assets-registry". */}}
{{- define "am.component" -}}
{{- printf "%s-%s" (include "am.fullname" .root) .name -}}
{{- end -}}

{{- define "am.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app.kubernetes.io/part-of: asset-management
{{- end -}}

{{- define "am.selectorLabels" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .name }}
{{- end -}}

{{- define "am.image" -}}
{{- printf "%s/%s%s:%s" .root.Values.image.registry .root.Values.image.prefix .name (default .root.Chart.AppVersion .root.Values.image.tag) -}}
{{- end -}}

{{- define "am.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "am.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "am.publicUrl" -}}
{{- required "publicUrl is required" .Values.publicUrl | trimSuffix "/" -}}
{{- end -}}

{{/*
OpenShift's restricted-v2 SCC assigns the UID; we only declare what we need
and never pin runAsUser/fsGroup, so the same chart works on vanilla Kubernetes.
*/}}
{{- define "am.podSecurityContext" -}}
runAsNonRoot: true
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "am.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}

{{/* Environment shared by every backend service, plus internal service URLs. */}}
{{- define "am.backendEnv" -}}
NODE_ENV: production
PORT: "8080"
PUBLIC_URL: {{ include "am.publicUrl" . | quote }}
AUTH_JWKS_URL: {{ printf "http://%s-identity:8080/api/identity/.well-known/jwks.json" (include "am.fullname" .) | quote }}
REGISTRY_URL: {{ printf "http://%s-registry:8080" (include "am.fullname" .) | quote }}
COOKIE_SECURE: "true"
MIGRATE_ON_START: "false"
{{- range $k, $v := .Values.config }}
{{ $k }}: {{ $v | quote }}
{{- end }}
{{- with .Values.observability }}
LOG_FORMAT: {{ .logs.format | quote }}
METRICS_ENABLED: {{ .metrics.enabled | toString | quote }}
OTEL_ENABLED: {{ .tracing.enabled | toString | quote }}
{{- if .tracing.enabled }}
OTEL_EXPORTER_OTLP_ENDPOINT: {{ ternary .tracing.elastic.serverUrl .tracing.endpoint (eq .tracing.backend "elastic") | quote }}
OTEL_EXPORTER_OTLP_PROTOCOL: {{ .tracing.protocol | quote }}
OTEL_TRACES_SAMPLER: parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG: {{ .tracing.samplingRatio | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{/* Per-component OpenTelemetry resource identity. */}}
{{- define "am.otelEnv" -}}
{{- if .root.Values.observability.tracing.enabled }}
OTEL_SERVICE_NAME: {{ printf "asset-management-%s" .name | quote }}
OTEL_RESOURCE_ATTRIBUTES: {{ printf "service.namespace=asset-management,service.version=%s,deployment.environment.name=%s,k8s.namespace.name=%s" (default .root.Chart.AppVersion .root.Values.image.tag) .root.Values.observability.environment .root.Release.Namespace | quote }}
{{- end }}
{{- end -}}
