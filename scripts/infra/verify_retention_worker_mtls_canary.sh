#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${NAMESPACE:-security}"
SECRET_NAME="${SECRET_NAME:?set the new worker TLS Secret name}"
OPENSEARCH_URL="${OPENSEARCH_URL:?set the private OpenSearch HTTPS URL}"
TEST_INDEX="${TEST_INDEX:?set an existing disposable audit index}"
EXPECTED_SUBJECT="${EXPECTED_SUBJECT:-}"
JOB_NAME="retention-mtls-canary-${RANDOM}${RANDOM}"
IMAGE="${CANARY_IMAGE:-curlimages/curl:8.10.1}"

cleanup() {
  set +e
  kubectl -n "$NAMESPACE" delete job "$JOB_NAME" --ignore-not-found --wait=false >/dev/null
}
trap cleanup EXIT

kubectl -n "$NAMESPACE" get secret "$SECRET_NAME" >/dev/null
kubectl -n "$NAMESPACE" get deployment umoja-retention-worker >/dev/null

cat <<EOF | kubectl apply -f - >/dev/null
apiVersion: batch/v1
kind: Job
metadata:
  name: $JOB_NAME
  namespace: $NAMESPACE
  labels:
    app.kubernetes.io/name: umoja-retention-worker-mtls-canary
    umoja.io/purpose: certificate-rotation
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 300
  template:
    metadata:
      labels:
        app.kubernetes.io/name: umoja-retention-worker-mtls-canary
    spec:
      automountServiceAccountToken: false
      restartPolicy: Never
      securityContext:
        seccompProfile: {type: RuntimeDefault}
      containers:
        - name: curl
          image: $IMAGE
          imagePullPolicy: IfNotPresent
          command: ["sh", "-ec"]
          args:
            - |
              test -s /tls/ca.crt
              test -s /tls/tls.crt
              test -s /tls/tls.key
              openssl x509 -in /tls/tls.crt -noout -checkend 604800
              openssl verify -CAfile /tls/ca.crt /tls/tls.crt
              curl --fail-with-body --silent --show-error \\
                --cert /tls/tls.crt --key /tls/tls.key --cacert /tls/ca.crt \\
                "${OPENSEARCH_URL%/}/$TEST_INDEX/_settings/index.uuid,index.version" \\
                | tee /tmp/identity.json
              status=$(curl --silent --show-error --output /tmp/forbidden.json --write-out '%{http_code}' \\
                --cert /tls/tls.crt --key /tls/tls.key --cacert /tls/ca.crt \\
                -X PUT "${OPENSEARCH_URL%/}/_plugins/_ism/policies/umoja-retention-canary-forbidden" \\
                --data '{}')
              test "$status" = 403
              echo "mtls_canary=passed forbidden_status=$status"
          securityContext:
            runAsNonRoot: true
            runAsUser: 65532
            runAsGroup: 65532
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: {drop: [ALL]}
          volumeMounts:
            - name: tls
              mountPath: /tls
              readOnly: true
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tls
          secret:
            secretName: $SECRET_NAME
            defaultMode: 0400
        - name: tmp
          emptyDir: {}
EOF

kubectl -n "$NAMESPACE" wait --for=condition=complete "job/$JOB_NAME" --timeout="${CANARY_TIMEOUT:-180}s"
kubectl -n "$NAMESPACE" logs "job/$JOB_NAME"

if [[ -n "$EXPECTED_SUBJECT" ]]; then
  actual=$(kubectl -n "$NAMESPACE" get secret "$SECRET_NAME" -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -subject | sed 's/^subject=//')
  test "$actual" = "$EXPECTED_SUBJECT" || { echo "certificate subject mismatch: $actual" >&2; exit 1; }
fi

echo "retention_worker_mtls_canary=passed secret=$SECRET_NAME"
