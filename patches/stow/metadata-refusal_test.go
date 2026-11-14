package s3api_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
	"github.com/chester-hill-solutions/stow-s3/internal/s3api"
	"github.com/chester-hill-solutions/stow-s3/internal/storage"
)

// Exercise the real SDK/HTTP mutation boundary, including overwrite and multipart
// initiation. A typed refusal must leave both the object and upload inventory alone.
func TestSDKUnsupportedObjectMetadataRefusedBeforeMutation(t *testing.T) {
	for _, field := range []string{"Cache-Control", "Content-Disposition", "Content-Encoding"} {
		t.Run(field, func(t *testing.T) {
			ctx := context.Background()
			store := storage.NewMemoryStore()
			t.Cleanup(func() { _ = store.Close() })
			client := metadataSDK(t, store)
			bucket := aws.String("metadata-refusal")
			if _, err := client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: bucket}); err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"source", "target"} {
				if _, err := client.PutObject(ctx, &s3.PutObjectInput{Bucket: bucket, Key: aws.String(key), Body: strings.NewReader("original"), ContentType: aws.String("text/plain"), Metadata: map[string]string{"basis": "original"}}); err != nil {
					t.Fatal(err)
				}
			}
			before, err := client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: bucket, Key: aws.String("target")})
			if err != nil {
				t.Fatal(err)
			}
			refused := func(err error) {
				t.Helper()
				var api smithy.APIError
				var response *smithyhttp.ResponseError
				if !errors.As(err, &api) || api.ErrorCode() != "NotImplemented" || !errors.As(err, &response) || response.HTTPStatusCode() != 501 {
					t.Fatalf("want typed 501 NotImplemented, got %v", err)
				}
			}
			for _, key := range []string{"target", "new"} {
				input := &s3.PutObjectInput{Bucket: bucket, Key: aws.String(key), Body: strings.NewReader("replacement")}
				switch field {
				case "Cache-Control":
					input.CacheControl = aws.String("max-age=123")
				case "Content-Disposition":
					input.ContentDisposition = aws.String("attachment")
				case "Content-Encoding":
					input.ContentEncoding = aws.String("identity")
				}
				_, err := client.PutObject(ctx, input)
				refused(err)
			}
			copy := &s3.CopyObjectInput{Bucket: bucket, Key: aws.String("target"), CopySource: aws.String("metadata-refusal/source"), MetadataDirective: types.MetadataDirectiveReplace}
			switch field {
			case "Cache-Control":
				copy.CacheControl = aws.String("max-age=123")
			case "Content-Disposition":
				copy.ContentDisposition = aws.String("attachment")
			case "Content-Encoding":
				copy.ContentEncoding = aws.String("identity")
			}
			_, err = client.CopyObject(ctx, copy)
			refused(err)
			multipart := &s3.CreateMultipartUploadInput{Bucket: bucket, Key: aws.String("pending")}
			switch field {
			case "Cache-Control":
				multipart.CacheControl = aws.String("max-age=123")
			case "Content-Disposition":
				multipart.ContentDisposition = aws.String("attachment")
			case "Content-Encoding":
				multipart.ContentEncoding = aws.String("identity")
			}
			_, err = client.CreateMultipartUpload(ctx, multipart)
			refused(err)
			object, err := client.GetObject(ctx, &s3.GetObjectInput{Bucket: bucket, Key: aws.String("target")})
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(object.Body)
			object.Body.Close()
			if err != nil || string(body) != "original" || aws.ToString(object.ContentType) != "text/plain" || !reflect.DeepEqual(object.Metadata, map[string]string{"basis": "original"}) || aws.ToString(object.ETag) != aws.ToString(before.ETag) || !object.LastModified.Equal(*before.LastModified) {
				t.Fatal("refused mutation changed original object")
			}
			listed, err := client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{Bucket: bucket})
			if err != nil || len(listed.Contents) != 2 {
				t.Fatalf("refused write created an object: %v %v", listed, err)
			}
			uploads, err := client.ListMultipartUploads(ctx, &s3.ListMultipartUploadsInput{Bucket: bucket})
			if err != nil || len(uploads.Uploads) != 0 {
				t.Fatalf("refused initiation created an upload: %v %v", uploads, err)
			}
		})
	}
}

// Malformed multipart selectors currently fall through to PutObject. They must
// not turn an unsupported metadata write into silent success.
func TestUnsupportedMetadataCannotBypassRefusalWithMultipartSelectors(t *testing.T) {
	for _, query := range []string{"?uploadId=unknown", "?partNumber=1", "?uploadId=unknown&partNumber=1"} {
		for _, header := range []string{"Cache-Control", "Content-Disposition", "Content-Encoding"} {
			t.Run(query+"/"+header, func(t *testing.T) {
				store := storage.NewMemoryStore()
				t.Cleanup(func() { _ = store.Close() })
				if err := store.CreateBucket(t.Context(), "bucket"); err != nil {
					t.Fatal(err)
				}
				server, err := s3api.New(s3api.Config{Store: store, Auth: s3api.DevBypass, Host: "127.0.0.1"})
				if err != nil {
					t.Fatal(err)
				}
				request := httptest.NewRequest(http.MethodPut, "http://127.0.0.1/bucket/key"+query, strings.NewReader("must not publish"))
				request.Header.Set(header, "identity")
				response := httptest.NewRecorder()
				server.Handler().ServeHTTP(response, request)
				if response.Code != http.StatusNotImplemented || !strings.Contains(response.Body.String(), "<Code>NotImplemented</Code>") {
					t.Fatalf("want typed 501 before mutation, got %d %s", response.Code, response.Body.String())
				}
				listed, err := store.ListObjectsV2(t.Context(), "bucket", storage.ListOptions{})
				if err != nil || len(listed.Objects) != 0 {
					t.Fatalf("refused selector write changed object inventory: %v %v", listed, err)
				}
			})
		}
	}
}
