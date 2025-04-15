variable "source_dir" {
  description = "Directory containing the source code"
  type        = string
}

variable "output_path" {
  description = "Path where the zip file will be created"
  type        = string
}

# Create a zip archive of the source code
data "archive_file" "source_code" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = var.output_path
}

output "output_path" {
  value = data.archive_file.source_code.output_path
}

output "output_base64sha256" {
  value = data.archive_file.source_code.output_base64sha256
}
