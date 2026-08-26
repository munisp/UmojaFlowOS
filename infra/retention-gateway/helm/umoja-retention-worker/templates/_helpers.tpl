{{- define "umoja-retention-worker.name" -}}
umoja-retention-worker
{{- end }}
{{- define "umoja-retention-worker.fullname" -}}
{{ .Release.Name }}-{{ include "umoja-retention-worker.name" . }}
{{- end }}
{{- define "umoja-retention-worker.labels" -}}
app.kubernetes.io/name: {{ include "umoja-retention-worker.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
{{- define "umoja-retention-worker.selectorLabels" -}}
app.kubernetes.io/name: {{ include "umoja-retention-worker.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
{{- define "umoja-retention-worker.serviceAccountName" -}}
{{- default (include "umoja-retention-worker.fullname" .) .Values.serviceAccount.name }}
{{- end }}
