{{- define "umoja-payment-engine.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "umoja-payment-engine.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "umoja-payment-engine.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "umoja-payment-engine.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "umoja-payment-engine.labels" -}}
helm.sh/chart: {{ include "umoja-payment-engine.chart" . }}
app.kubernetes.io/name: {{ include "umoja-payment-engine.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: umojaflowos
app.kubernetes.io/component: payment-engine
{{- end }}

{{- define "umoja-payment-engine.selectorLabels" -}}
app.kubernetes.io/name: {{ include "umoja-payment-engine.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "umoja-payment-engine.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "umoja-payment-engine.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- required "serviceAccount.name is required when serviceAccount.create is false" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
