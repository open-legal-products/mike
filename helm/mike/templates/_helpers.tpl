{{- define "mike.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "mike.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "mike.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "mike.labels" -}}
app.kubernetes.io/name: {{ include "mike.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "mike.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mike.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Component service names. Every name is release-prefixed because this chart
     shares the `default` namespace with unrelated releases. */}}
{{- define "mike.db" -}}{{ include "mike.fullname" . }}-db{{- end -}}
{{- define "mike.auth" -}}{{ include "mike.fullname" . }}-auth{{- end -}}
{{- define "mike.rest" -}}{{ include "mike.fullname" . }}-rest{{- end -}}
{{- define "mike.gateway" -}}{{ include "mike.fullname" . }}-gateway{{- end -}}
{{- define "mike.storage" -}}{{ include "mike.fullname" . }}-storage{{- end -}}
{{- define "mike.redis" -}}{{ include "mike.fullname" . }}-redis{{- end -}}
{{- define "mike.backend" -}}{{ include "mike.fullname" . }}-backend{{- end -}}
{{- define "mike.frontend" -}}{{ include "mike.fullname" . }}-frontend{{- end -}}

{{/* The image tag is never defaulted: the chart pins both images to one tag,
     so an unset tag must stop the release rather than deploy something else. */}}
{{- define "mike.imageTag" -}}
{{- required "image.tag is required — deploy a tag the build pipeline actually produced" .Values.image.tag -}}
{{- end -}}

{{- define "mike.publicUrl" -}}
{{- required "publicUrl is required — auth links and the OAuth callback are built from it" .Values.publicUrl -}}
{{- end -}}
