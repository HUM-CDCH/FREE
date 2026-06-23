from paddleocr import PPStructureV3

pipeline = PPStructureV3(
    text_detection_model_name="PP-OCRv6_medium_det",
    use_doc_orientation_classify=False, # Use use_doc_orientation_classify to enable/disable document orientation classification model
    use_doc_unwarping=False,    # Use use_doc_unwarping to enable/disable document unwarping module
    use_textline_orientation=False, # Use use_textline_orientation to enable/disable textline orientation classification model
    device="gpu:0", # Use device to specify GPU for model inference
    )
output = pipeline.predict("./pp_structure_v3_demo.png")
for res in output:
    res.print() # Print the structured prediction output
    res.save_to_json(save_path="output") ## Save the current image's structured result in JSON format
    res.save_to_markdown(save_path="output") ## Save the current image's result in Markdown format
